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
    members: [{ user_id: "11" }, { user_id: "12" }, { user_id: "13" }],
    error: null,
    accounts: [
      { id: "101", cycle_id: "20", type: "ASSET", code: "1300" },
      { id: "102", cycle_id: "20", type: "INCOME", code: "4100" },
    ],
    writes: [],
  };
  let header;
  let nextId = 200;
  Object.defineProperty(db, "transaction", {
    value: async (fn) => {
      const before = state.writes.length;
      try {
        const result = await fn(db);
        if (state.error) throw state.error;
        return result;
      } catch (error) {
        state.writes.length = before;
        throw error;
      }
    },
  });
  db.client.runner = (builder) => ({
    run: async () => {
      const q = builder.toSQL();
      if (q.sql.includes('from "groups"'))
        return q.bindings[0] === "alpha"
          ? { id: "1" }
          : q.bindings[0] === "beta"
            ? { id: "2" }
            : undefined;
      if (q.sql.includes('from "users"')) {
        assert.match(q.sql, /for share/);
        return q.sql.includes('"auth_user_id"') && q.bindings[1] === "1"
          ? { id: "10", role: state.role }
          : undefined;
      }
      if (q.sql.includes('from "accounts"')) {
        assert.equal(q.bindings[0], "1");
        assert.match(q.sql, /for share/);
        return state.accounts.filter((account) =>
          q.bindings.slice(1).includes(account.id),
        );
      }
      if (q.sql.includes('from "cycles"')) {
        assert.deepEqual(q.bindings, [
          "1",
          "draft",
          "active",
          "distributing",
          1,
        ]);
        assert.match(q.sql, /for update/);
        return state.cycle ? { id: "20" } : undefined;
      }
      if (q.sql.includes('from "cycle_members"')) {
        assert.deepEqual(q.bindings, ["20", "1"]);
        assert.match(q.sql, /inner join "users".*for share/);
        return state.members;
      }
      if (q.method === "insert") {
        const rows = [builder._single.insert]
          .flat()
          .map((row) => ({ id: String(nextId++), ...row }));
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
    path = "/api/v1/penalties/charge",
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

const input = { debit: "101", credit: "102", amount: "25.50" };

test("penalty charge creates a PENALTY header and balanced CHARGE_PENALTY member entries", async (t) => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post({ ...input, description: "Absence penalty" });
    assert.equal(result.status, 201);
    for (const entry of result.body.entries) {
      const postings = result.body.account_entries.filter(posting => posting.transaction_entry_id === entry.id);
      assert.equal(entry.debit, postings.find(posting => Number(posting.amount) > 0).account_id);
      assert.equal(entry.credit, postings.find(posting => Number(posting.amount) < 0).account_id);
    }
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.success, true);
    assert.equal(result.body.transaction.type, "PENALTY");
    assert.equal(result.body.transaction.amount, "76.50");
    assert.equal(result.body.transaction.user_id, null);
    assert.equal(result.body.transaction.cycle_id, "20");
    assert.equal(result.body.transaction.description, "Absence penalty");
    assert.deepEqual(
      result.body.entries.map((entry) => [
        entry.user_id,
        entry.type,
        entry.amount,
        entry.cycle_id,
      ]),
      [
        ["11", "CHARGE_PENALTY", "25.50", "20"],
        ["12", "CHARGE_PENALTY", "25.50", "20"],
        ["13", "CHARGE_PENALTY", "25.50", "20"],
      ],
    );
    assert.equal(result.body.account_entries.length, 6);
    for (const entry of result.body.entries) {
      assert.deepEqual(
        result.body.account_entries
          .filter((posting) => posting.transaction_entry_id === entry.id)
          .map((posting) => [posting.account_id, posting.amount]),
        [
          ["101", "25.50"],
          ["102", "-25.50"],
        ],
      );
    }
  }
});

test("penalty charge validates amounts, IDs and supported fields before writes", async (t) => {
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
  for (const id of [null, [], {}, 1.5, 0, -1, "9223372036854775808", "01"]) {
    for (const field of ["debit", "credit"])
      assert.equal((await post({ ...input, [field]: id })).status, 400);
  }
  for (const body of [
    null,
    [],
    {},
    { ...input, debit: "102" },
    ...["group_id", "cycle_id", "user_id", "type", "entries"].map((field) => ({
      ...input,
      [field]: "1",
    })),
    ...["\u0000", "x".repeat(4001), 1, {}].map((description) => ({
      ...input,
      description,
    })),
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(input, {}, '{"amount":')).status, 400);
  assert.equal(state.writes.length, 0);
});

test("penalty charge requires authentication and a financial role in the group", async (t) => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, { authorization: "" })).status, 401);
  assert.equal((await post(input, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(input, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "AUDITOR", null, "owner"]) {
    state.role = role;
    assert.equal((await post(input)).status, 403);
  }
  assert.equal(state.writes.length, 0);
});

test("penalty charge requires a current cycle, enrolled members and the correct scoped accounts", async (t) => {
  const { state, post } = fixture(t);
  state.cycle = false;
  assert.equal((await post(input)).status, 409);
  state.cycle = true;
  const members = state.members;
  state.members = [];
  assert.equal((await post(input)).status, 409);
  state.members = members;
  for (const field of ["debit", "credit"])
    assert.equal((await post({ ...input, [field]: "999" })).status, 404);
  for (const account of state.accounts) {
    for (const [field, value] of [
      ["cycle_id", "99"],
      ["code", "1000"],
      ["type", "EXPENSE"],
    ]) {
      const original = account[field];
      account[field] = value;
      assert.equal((await post(input)).status, 400);
      account[field] = original;
    }
  }
  assert.equal(state.writes.length, 0);
});

test("penalty charge preserves exact cents and rejects aggregate overflow", async (t) => {
  const { state, post } = fixture(t);
  assert.equal(
    (await post({ ...input, amount: "9999999999999999.99" })).status,
    400,
  );
  assert.equal(state.writes.length, 0);
  const maximum = await post({ ...input, amount: "3333333333333333.33" });
  assert.equal(maximum.status, 201);
  assert.equal(maximum.body.transaction.amount, "9999999999999999.99");
  assert.equal(
    (await post({ ...input, amount: 0.01 })).body.transaction.amount,
    "0.03",
  );
});

test("penalty charge rolls back commit conflicts and hides unexpected errors", async (t) => {
  const { state, post } = fixture(t);
  for (const code of ["23001", "23503", "23505", "23514", "40001", "40P01"]) {
    state.error = Object.assign(new Error("private error"), { code });
    const result = await post(input);
    assert.equal(result.status, 409);
    assert.equal(state.writes.length, 0);
    assert.doesNotMatch(result.body.error, /private/);
  }
  state.error = new Error("private details");
  assert.equal((await post(input)).status, 500);
  assert.equal(state.writes.length, 0);
});
