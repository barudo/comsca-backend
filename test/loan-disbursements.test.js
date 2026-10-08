const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = {
    role: "OWNER",
    cycle: true,
    cycleStatus: "active",
    voucherCounter: "0",
    member: true,
    membership: true,
    error: null,
    accounts: [
      { id: "101", cycle_id: "20", type: "ASSET", code: "1000" },
      { id: "102", cycle_id: "20", type: "ASSET", code: "1100" },
      { id: "106", cycle_id: "20", type: "EQUITY", code: "3000" },
      { id: "107", cycle_id: "20", type: "ASSET", code: "1300" },
      { id: "108", cycle_id: "20", type: "INCOME", code: "4100" },
    ],
    writes: [],
    queries: [],
  };
  let header;
  Object.defineProperty(db, "transaction", {
    value: async (fn) => {
      const before = state.writes.length;
      const counterBefore = state.voucherCounter;
      try {
        const result = await fn(db);
        if (state.error) throw state.error;
        return result;
      } catch (error) {
        state.writes.length = before;
        state.voucherCounter = counterBefore;
        throw error;
      }
    },
  });
  db.client.runner = (builder) => ({
    run: async () => {
      const q = builder.toSQL();
      state.queries.push(q);
      if (q.sql.includes('from "groups"'))
        return q.bindings[0] === "alpha"
          ? { id: "1" }
          : q.bindings[0] === "beta"
            ? { id: "2" }
            : undefined;
      if (q.sql.includes('from "users"')) {
        assert.match(q.sql, /for share/);
        if (q.sql.includes('"auth_user_id"'))
          return q.bindings[1] === "1"
            ? { id: "10", role: state.role }
            : undefined;
        assert.deepEqual(q.bindings, ["11", "1", 1]);
        return state.member ? { id: "11" } : undefined;
      }
      if (q.sql.includes('from "accounts"')) {
        assert.match(q.sql, /"group_id" = \?.*for share/);
        assert.equal(q.bindings[0], "1");
        return state.accounts.filter((account) =>
          q.bindings.slice(1).includes(account.id),
        );
      }
      if (q.sql.includes('from "cycles"')) {
        assert.deepEqual(q.bindings, ["1", "active", "distributing", 1]);
        assert.match(q.sql, /for update/);
        return state.cycle && ["active", "distributing"].includes(state.cycleStatus) ? { id: "20" } : undefined;
      }
      if (q.sql.includes('from "cycle_members"')) {
        assert.deepEqual(q.bindings, ["11", "20", 1]);
        return state.membership ? { user_id: "11" } : undefined;
      }
      if (q.method === "update" && builder._single.table === "cycles") {
        assert.match(q.sql, /"disbursement_voucher_counter" = "disbursement_voucher_counter" \+ \?/);
        assert.deepEqual(q.bindings, [1, "20", "1"]);
        state.voucherCounter = String(BigInt(state.voucherCounter) + 1n);
        return [{ disbursement_voucher_counter: state.voucherCounter }];
      }
      if (q.method === "insert") {
        if (state.failTable === builder._single.table) throw Object.assign(new Error("write failed"), { code: "23514" });
        const rows = [builder._single.insert]
          .flat()
          .map((row, i) => ({
            id: String(200 + state.writes.length + i),
            ...row,
          }));
        state.writes.push({ table: builder._single.table, rows });
        if (builder._single.table === "transactions") header = rows[0];
        return rows;
      }
      assert.match(q.sql, /from "transactions"/);
      return header;
    },
  });
  const handler = serverless(
    createApp(db, {
      getUser: async () => ({
        id: "auth-user",
        user_metadata: { role: "OWNER" },
      }),
    }),
  );
  const post = async (
    body = {},
    headers = {},
    rawBody,
    path = "/api/v1/transactions/disburse-loans",
  ) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: path,
        rawQueryString: "group_id=2",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer token",
          "x-group-slug": "alpha",
          ...headers,
        },
        requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
        body: rawBody ?? JSON.stringify(body),
        isBase64Encoded: false,
      },
      {},
    );
    return {
      status: result.statusCode,
      body: result.headers["content-type"]?.includes("application/json")
        ? JSON.parse(result.body)
        : result.body,
      headers: result.headers,
    };
  };
  return { state, post };
}
const input = { user_id: "11", debit: "102", credit: "101", amount: "500.00" };

test("loan disbursements POST creates one member component with balanced postings for financial writers", async (t) => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post({ ...input, description: "Member loan" });
    assert.equal(result.status, 201);
    for (const entry of result.body.entries) {
      const postings = result.body.account_entries.filter(posting => posting.transaction_entry_id === entry.id);
      assert.equal(entry.debit, postings.find(posting => Number(posting.amount) > 0).account_id);
      assert.equal(entry.credit, postings.find(posting => Number(posting.amount) < 0).account_id);
    }
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.success, true);
    assert.equal(result.body.transaction.type, "LOAN_DISBURSED");
    assert.equal(result.body.transaction.amount, "500.00");
    assert.equal(result.body.transaction.cycle_id, "20");
    assert.equal(result.body.transaction.user_id, "11");
    assert.equal(result.body.transaction.description, "Member loan");
    assert.equal(result.body.entries.length, 1);
    const entry = result.body.entries[0];
    assert.equal(entry.type, "LOAN_DISBURSED");
    assert.equal(entry.amount, "500.00");
    assert.equal(entry.group_id, "1");
    assert.equal(entry.user_id, "11");
    assert.equal(entry.cycle_id, "20");
    assert.equal(entry.transaction_id, result.body.transaction.id);
    assert.deepEqual(
      result.body.account_entries.map((p) => [p.account_id, p.amount]),
      [
        ["102", "500.00"],
        ["101", "-500.00"],
      ],
    );
    assert.ok(
      result.body.account_entries.every(
        (p) => p.group_id === "1" && p.transaction_entry_id === entry.id,
      ),
    );
  }
});

test("loan disbursements POST preserves cents and accepts numeric IDs and money", async (t) => {
  const { post } = fixture(t);
  const maximum = await post({ ...input, amount: "9999999999999999.99" });
  assert.equal(maximum.status, 201);
  assert.equal(maximum.body.transaction.amount, "9999999999999999.99");
  assert.equal(maximum.body.account_entries[1].amount, "-9999999999999999.99");
  const minimum = await post({
    ...input,
    debit: 102,
    credit: 101,
    user_id: 11,
    amount: 0.01,
  });
  assert.equal(minimum.status, 201);
  assert.equal(minimum.body.transaction.amount, "0.01");
});

test("loan disbursements POST rejects invalid money, identifiers, descriptions and unsupported fields before writes", async (t) => {
  const { state, post } = fixture(t);
  for (const amount of [
    undefined,
    0,
    -1,
    "NaN",
    "Infinity",
    "1e3",
    "0.001",
    "10000000000000000",
    true,
    {},
    null,
    1000000000001,
  ]) {
    assert.equal(
      (await post({ ...input, amount })).status,
      400,
      String(amount),
    );
  }
  for (const id of [
    null,
    [],
    [101],
    {},
    1.5,
    0,
    -1,
    "9223372036854775808",
    "01",
  ]) {
    for (const field of ["debit", "credit", "user_id"]) {
      assert.equal((await post({ ...input, [field]: id })).status, 400, field);
    }
  }
  for (const body of [
    null,
    [],
    {},
    ...["user_id", "debit", "credit"].map((field) => ({
      ...input,
      [field]: undefined,
    })),
    { ...input, group_id: "2" },
    { ...input, type: "LOAN_DISBURSED" },
    { ...input, entries: [] },
    { ...input, cycle_id: "bad" },
    { ...input, debit: "101" },
    ...["\u0000", "x".repeat(4001), 1, {}].map((description) => ({
      ...input,
      description,
    })),
  ])
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post(input, {}, '{"user_id":')).status, 400);
  assert.equal(state.writes.length, 0);
});

test("loan disbursements POST authenticates and scopes financial writers to the header group", async (t) => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, { authorization: "" })).status, 401);
  assert.equal((await post(input, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(input, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "AUDITOR", null, "owner"]) {
    state.role = role;
    assert.equal((await post(input)).status, 403);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(
    state.queries.some((q) => q.sql.includes('from "accounts"')),
    false,
  );
});

test("loan disbursements POST requires loans receivable debit and a distinct asset funding account", async (t) => {
  const { state, post } = fixture(t);
  for (const changes of [
    { debit: "107" },
    { debit: "106" },
    { credit: "106" },
    { credit: "108" },
    { credit: "102" },
  ]) {
    assert.equal((await post({ ...input, ...changes })).status, 400);
  }
  state.accounts[1].type = "INCOME";
  assert.equal((await post(input)).status, 400);
  state.accounts[1].type = "ASSET";
  state.accounts[0].type = "INCOME";
  assert.equal((await post(input)).status, 400);
  assert.equal(state.writes.length, 0);
});

test("loan disbursements POST enforces account scope, shared cycle and member enrollment", async (t) => {
  const { state, post } = fixture(t);
  assert.equal((await post({ ...input, debit: "999" })).status, 404);
  assert.equal((await post({ ...input, credit: "999" })).status, 404);
  assert.equal((await post({ ...input, cycle_id: "99" })).status, 400);
  state.accounts[0].cycle_id = "99";
  assert.equal((await post(input)).status, 400);
  state.accounts[0].cycle_id = "20";
  state.member = false;
  assert.equal((await post(input)).status, 404);
  state.member = true;
  state.membership = false;
  assert.equal((await post(input)).status, 400);
  state.membership = true;
  state.accounts.forEach((a) => {
    a.cycle_id = null;
  });
  assert.equal(state.writes.length, 0);
  assert.equal((await post(input)).status, 201);
  assert.equal((await post({ ...input, cycle_id: "20" })).status, 201);
  state.cycle = false;
  assert.equal((await post({ ...input, cycle_id: "20" })).status, 409);
});

test("loan disbursements POST rolls back and sanitizes commit and server errors", async (t) => {
  const { state, post } = fixture(t);
  for (const code of ["23503", "23514", "40001", "40P01"]) {
    state.error = Object.assign(new Error("private error"), { code });
    const result = await post(input);
    assert.equal(result.status, 409);
    assert.equal(state.writes.length, 0);
    assert.doesNotMatch(result.body.error, /private/);
  }
  state.error = new Error("private server details");
  const result = await post(input);
  assert.equal(result.status, 500);
  assert.equal(state.writes.length, 0);
  assert.equal(result.body.error, "Internal server error");
});

test("loan vouchers increment once, preserve bigint precision, and roll back failed postings", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(input)).body.transaction.document_number, "1");
  state.voucherCounter = "9007199254740992";
  const result = await post(input);
  assert.equal(result.status, 201);
  assert.equal(result.body.transaction.document_type, "DISBURSEMENT_VOUCHER");
  assert.equal(result.body.transaction.document_number, "9007199254740993");
  assert.match(state.queries.find(q => q.sql.includes('from "transactions"')).sql, /"document_type", "document_number"/);
  for (const table of ["transactions", "transaction_entries", "account_entries"]) {
    state.failTable = table;
    assert.equal((await post(input)).status, 409);
    assert.equal(state.voucherCounter, "9007199254740993");
  }
  state.failTable = null;
  state.error = Object.assign(new Error("commit failed"), { code: "40001" });
  assert.equal((await post(input)).status, 409);
  assert.equal(state.voucherCounter, "9007199254740993");
  state.error = null;
  assert.equal((await post(input)).body.transaction.document_number, "9007199254740994");
});

test("loan vouchers require the group's current writable cycle", async t => {
  const { state, post } = fixture(t);
  for (const cycleStatus of ["draft", "closed"]) {
    state.cycleStatus = cycleStatus;
    assert.equal((await post(input)).status, 409);
    assert.equal(state.voucherCounter, "0");
  }
  state.cycleStatus = "distributing";
  assert.equal((await post(input)).status, 201);
  assert.equal((await post({ ...input, document_number: 5 })).status, 400);
  assert.equal((await post({ ...input, document_type: "RECEIPT" })).status, 400);
});
