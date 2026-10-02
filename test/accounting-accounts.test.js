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
      assert.match(query.sql, /SUM\(ae\.amount\) FILTER \(WHERE t\.id IS NOT NULL\)/);
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
        rawPath: "/api/v1/accounting/accounts",
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

test("accounting accounts return grouped current-cycle journal balances", async (t) => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "1", code: "1000", name: "Cash", type: "ASSET", current_balance: "125.00", total_balance: "125.00" },
    { id: "2", code: "3000", name: "Share capital", type: "EQUITY", current_balance: "125.00", total_balance: "125.00" },
    { id: "3", code: "4000", name: "Interest income", type: "INCOME", current_balance: "12.50", total_balance: "12.50" },
  ];
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, "20");
  assert.deepEqual(result.body.accounts, [
    { type: "ASSET", total_balance: "125.00", sub_accounts: [{ id: "1", code: "1000", name: "Cash", current_balance: "125.00" }] },
    { type: "LIABILITY", total_balance: "0.00", sub_accounts: [] },
    { type: "EQUITY", total_balance: "125.00", sub_accounts: [{ id: "2", code: "3000", name: "Share capital", current_balance: "125.00" }] },
    { type: "INCOME", total_balance: "12.50", sub_accounts: [{ id: "3", code: "4000", name: "Interest income", current_balance: "12.50" }] },
    { type: "EXPENSE", total_balance: "0.00", sub_accounts: [] },
  ]);
});

test("accounting accounts restrict access and return zeroed types without an active cycle", async (t) => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  state.role = "MEMBER";
  assert.equal((await get()).status, 403);
  state.role = "OWNER";
  state.cycle = undefined;
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, null);
  assert.equal(result.body.accounts.length, 5);
  assert.ok(result.body.accounts.every((group) => group.total_balance === "0.00" && group.sub_accounts.length === 0));
});