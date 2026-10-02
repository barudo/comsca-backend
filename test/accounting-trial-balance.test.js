const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: { id: "20" }, queries: [], rows: [] };
  Object.defineProperty(db, "transaction", { value: async (fn) => fn(db) });
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
      if (query.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY") {
        return {};
      }
      if (query.sql.includes('from "users"')) {
        return query.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
      }
      if (query.sql.includes('from "cycles"')) {
        assert.deepEqual(query.bindings, ["1", "active", "distributing", 1]);
        return state.cycle;
      }
      assert.match(query.sql, /FROM accounts a/);
      assert.match(query.sql, /a\.group_id = \? AND a\.cycle_id = \?/);
      assert.match(query.sql, /t\.cycle_id = a\.cycle_id/);
      assert.match(query.sql, /SUM\(ae\.amount\) FILTER/);
      assert.match(query.sql, /SUM\(-ae\.amount\) FILTER/);
      assert.match(query.sql, /GREATEST\(total_debits - total_credits, 0\.00\)/);
      assert.match(query.sql, /GREATEST\(total_credits - total_debits, 0\.00\)/);
      assert.deepEqual(query.bindings, ["1", "20"]);
      return { rows: state.rows };
    },
  });
  const handler = serverless(
    createApp(db, { getUser: async () => ({ id: "verified-user" }) }),
  );
  const get = async (headers = {}) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: "/api/v1/accounting/trial-balance",
        rawQueryString: "group_id=2&cycle_id=999",
        headers: {
          authorization: "Bearer token",
          "x-group-slug": "alpha",
          ...headers,
        },
        requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } },
      },
      {},
    );
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, get };
}

test("trial balance returns journal totals and positive net balances per account", async (t) => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "1", code: "1000", name: "Cash", type: "ASSET", total_debits: "150.00", total_credits: "25.00", debit_balance: "125.00", credit_balance: "0.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
    { id: "2", code: "1200", name: "Loans receivable", type: "ASSET", total_debits: "100.00", total_credits: "0.00", debit_balance: "100.00", credit_balance: "0.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
    { id: "3", code: "2000", name: "Savings payable", type: "LIABILITY", total_debits: "20.00", total_credits: "120.00", debit_balance: "0.00", credit_balance: "100.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
    { id: "4", code: "3000", name: "Share capital", type: "EQUITY", total_debits: "0.00", total_credits: "125.00", debit_balance: "0.00", credit_balance: "125.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
    { id: "5", code: "4000", name: "Interest income", type: "INCOME", total_debits: "0.00", total_credits: "50.00", debit_balance: "0.00", credit_balance: "50.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
    { id: "6", code: "5000", name: "Operating expenses", type: "EXPENSE", total_debits: "50.00", total_credits: "0.00", debit_balance: "50.00", credit_balance: "0.00", summary_debits: "275.00", summary_credits: "275.00", difference: "0.00" },
  ];
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, "20");
  assert.deepEqual(result.body.accounts[0], {
    id: "1",
    code: "1000",
    name: "Cash",
    type: "ASSET",
    total_debits: "150.00",
    total_credits: "25.00",
    debit_balance: "125.00",
    credit_balance: "0.00",
  });
  assert.deepEqual(result.body.summary, {
    total_debits: "275.00",
    total_credits: "275.00",
    difference: "0.00",
  });
});

test("trial balance rejects unauthorized callers and returns zero totals without an active cycle", async (t) => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);

  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
    state.role = role;
    assert.equal((await get()).status, 200);
  }
  state.queries.length = 0;
  state.role = "MEMBER";
  assert.equal((await get()).status, 403);
  assert.equal(
    state.queries.some((query) => query.sql.includes('from "cycles"')),
    false,
  );

  state.role = "OWNER";
  state.cycle = undefined;
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, null);
  assert.deepEqual(result.body.accounts, []);
  assert.deepEqual(result.body.summary, {
    total_debits: "0.00",
    total_credits: "0.00",
    difference: "0.00",
  });
});