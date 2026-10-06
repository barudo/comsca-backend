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
    cycle: {
      id: "20",
      interest_rate: "2.500000",
      interest_period: "MONTHLY",
      interest_method: "SIMPLE",
    },
    accounts: [
      { id: "101", cycle_id: "20", type: "ASSET" },
      { id: "102", cycle_id: "20", type: "INCOME" },
    ],
    events: [],
    writes: [],
    queries: [],
    commitError: null,
    writeError: null,
    invalidToken: false,
  };
  let header;
  let nextId = 200;
  Object.defineProperty(db, "transaction", {
    value: async (fn) => {
      const before = state.writes.length;
      try {
        const result = await fn(db);
        if (state.commitError) throw state.commitError;
        return result;
      } catch (error) {
        state.writes.length = before;
        throw error;
      }
    },
  });
  db.client.runner = (builder) => ({
    run: async () => {
      const query = builder.toSQL();
      state.queries.push(query);
      if (query.sql.includes('from "groups"')) {
        return query.bindings[0] === "alpha"
          ? { id: "1" }
          : query.bindings[0] === "beta"
            ? { id: "2" }
            : undefined;
      }
      if (query.sql.includes('from "users"')) {
        return query.sql.includes('"auth_user_id"') && query.bindings[1] === "1"
          ? { id: "10", role: state.role }
          : undefined;
      }
      if (query.sql.includes('from "cycles"')) return state.cycle;
      if (query.sql.includes('from "accounts"')) {
        assert.equal(query.bindings[0], "1");
        return state.accounts.filter((account) =>
          query.bindings.slice(1).includes(account.id),
        );
      }
      if (query.sql.includes("FROM transaction_entries e")) {
        assert.deepEqual(query.bindings, ["1", "1", "20", "20", "1"]);
        assert.match(query.sql, /ORDER BY u\.id, t\.occurred_at, t\.id, e\.id/);
        assert.match(query.sql, /e\.group_id = \? AND t\.group_id = \?/);
        return { rows: state.events };
      }
      if (query.sql.includes("ROUND(")) {
        const rateUnits = BigInt(String(query.bindings[0]).replace(".", ""));
        const rows = [];
        for (let index = 1; index < query.bindings.length; index += 2) {
          const numerator = BigInt(query.bindings[index + 1]) * rateUnits;
          const denominator = 100000000n;
          const roundedCents = (numerator + denominator / 2n) / denominator;
          rows.push({
            user_id: query.bindings[index],
            amount: `${roundedCents / 100n}.${String(roundedCents % 100n).padStart(2, "0")}`,
          });
        }
        return { rows };
      }
      if (query.method === "insert") {
        if (
          state.writeError &&
          builder._single.table === state.writeError.table
        )
          throw state.writeError.error;
        const rows = [builder._single.insert]
          .flat()
          .map((row) => ({ id: String(nextId++), ...row }));
        state.writes.push({ table: builder._single.table, rows });
        if (builder._single.table === "transactions") header = rows[0];
        return rows;
      }
      assert.match(query.sql, /from "transactions"/);
      return header;
    },
  });
  const handler = serverless(
    createApp(db, {
      getUser: async () => {
        if (state.invalidToken)
          throw Object.assign(new Error("Invalid access token"), {
            status: 401,
          });
        return { id: "verified-user" };
      },
    }),
  );
  const post = async (
    body = { debit: "101", credit: "102" },
    headers = {},
    rawBody,
  ) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: "/api/v1/interests/charge",
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
      body: JSON.parse(result.body),
      headers: result.headers,
    };
  };
  return { state, post };
}

function event(user_id, type, amount, id) {
  return {
    user_id,
    type,
    amount,
    occurred_at: `2026-09-0${id}T00:00:00Z`,
    transaction_id: String(id),
    entry_id: String(id),
  };
}

test("interest charge reconstructs loans chronologically and applies payments to interest first", async (t) => {
  const { state, post } = fixture(t);
  state.events = [
    event("11", "LOAN_DISBURSED", "1000.00", 1),
    event("11", "LOAN_INTEREST", "80.00", 2),
    event("11", "LOAN_PAYMENT", "100.00", 3),
  ];
  const result = await post();
  assert.equal(result.status, 201);
    for (const entry of result.body.entries) {
      const postings = result.body.account_entries.filter(posting => posting.transaction_entry_id === entry.id);
      assert.equal(entry.debit, postings.find(posting => Number(posting.amount) > 0).account_id);
      assert.equal(entry.credit, postings.find(posting => Number(posting.amount) < 0).account_id);
    }
  assert.equal(result.body.transaction.type, "LOAN_INTEREST");
  assert.equal(result.body.transaction.amount, "24.50");
  assert.equal(result.body.entries.length, 1);
  assert.deepEqual(
    result.body.entries.map((entry) => [
      entry.user_id,
      entry.amount,
      entry.type,
    ]),
    [["11", "24.50", "LOAN_INTEREST"]],
  );
  assert.deepEqual(
    result.body.account_entries.map((row) => [row.account_id, row.amount]),
    [
      ["101", "24.50"],
      ["102", "-24.50"],
    ],
  );
  assert.equal(result.headers["cache-control"], "no-store");
});

test("interest charge uses compound unpaid interest and PostgreSQL cent rounding", async (t) => {
  const { state, post } = fixture(t);
  state.cycle.interest_method = "COMPOUND";
  state.events = [event("11", "LOAN_DISBURSED", "1.00", 1)];
  const result = await post();
  assert.equal(result.status, 201);
    for (const entry of result.body.entries) {
      const postings = result.body.account_entries.filter(posting => posting.transaction_entry_id === entry.id);
      assert.equal(entry.debit, postings.find(posting => Number(posting.amount) > 0).account_id);
      assert.equal(entry.credit, postings.find(posting => Number(posting.amount) < 0).account_id);
    }
  assert.equal(result.body.transaction.amount, "0.03");
  state.writes.length = 0;
  state.events = [
    event("11", "LOAN_DISBURSED", "1.00", 1),
    event("11", "LOAN_INTEREST", "0.03", 2),
  ];
  const compound = await post();
  assert.equal(compound.body.transaction.amount, "0.03");
});

test("interest charge returns 409 without writes for missing terms or no positive rounded interest", async (t) => {
  const { state, post } = fixture(t);
  state.cycle.interest_rate = null;
  assert.equal((await post()).status, 409);
  assert.equal(state.writes.length, 0);
  state.cycle.interest_rate = "2.500000";
  state.events = [event("11", "LOAN_DISBURSED", "0.01", 1)];
  assert.equal((await post()).status, 409);
  assert.equal(state.writes.length, 0);
  state.events = [];
  assert.equal((await post()).status, 409);
  assert.equal(state.writes.length, 0);
});

test("interest charge validates group-scoped accounts, authorization and input before writes", async (t) => {
  const { state, post } = fixture(t);
  state.events = [event("11", "LOAN_DISBURSED", "100.00", 1)];
  assert.equal((await post({ debit: "101", credit: "999" })).status, 404);
  state.accounts[1].type = "ASSET";
  assert.equal((await post()).status, 400);
  state.accounts[1].type = "INCOME";
  state.accounts[0].cycle_id = "99";
  assert.equal((await post()).status, 400);
  state.accounts[0].cycle_id = "20";
  for (const body of [
    {},
    { debit: "101" },
    { debit: "101", credit: "101" },
    { debit: "101", credit: "102", amount: "1.00" },
    null,
    [],
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(undefined, { authorization: "" })).status, 401);
  assert.equal((await post(undefined, { "x-group-slug": "beta" })).status, 403);
  state.role = "AUDITOR";
  assert.equal((await post()).status, 403);
  assert.equal(state.writes.length, 0);
});

test("interest charge rolls back account, commit and unexpected failures", async (t) => {
  const { state, post } = fixture(t);
  state.events = [event("11", "LOAN_DISBURSED", "100.00", 1)];
  state.writeError = {
    table: "account_entries",
    error: Object.assign(new Error("private"), { code: "23514" }),
  };
  assert.equal((await post()).status, 409);
  assert.equal(state.writes.length, 0);
  state.writeError = null;
  state.commitError = Object.assign(new Error("private"), { code: "40001" });
  assert.equal((await post()).status, 409);
  assert.equal(state.writes.length, 0);
  state.commitError = new Error("private");
  const unexpected = await post();
  assert.equal(unexpected.status, 500);
  assert.equal(state.writes.length, 0);
});
