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
      assert.match(query.sql, /income_total - expense_total/);
      assert.match(query.sql, /total_assets - total_liabilities/);
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
        rawPath: "/api/v1/accounting/balance-sheet",
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
    return {
      status: result.statusCode,
      body: JSON.parse(result.body),
      headers: result.headers,
    };
  };
  return { state, get };
}

test("balance sheet reports normal-side balances and includes current earnings in equity", async (t) => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "1", code: "1000", name: "Cash", type: "ASSET", balance: "1400.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
    { id: "2", code: "1100", name: "Loans receivable", type: "ASSET", balance: "200.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
    { id: "3", code: "2000", name: "Accounts payable", type: "LIABILITY", balance: "200.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
    { id: "4", code: "3000", name: "Equity", type: "EQUITY", balance: "900.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
    { id: "5", code: "4000", name: "Interest income", type: "INCOME", balance: "600.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
    { id: "6", code: "5000", name: "Expenses", type: "EXPENSE", balance: "100.00", total_assets: "1600.00", total_liabilities: "200.00", equity_accounts_total: "900.00", income_total: "600.00", expense_total: "100.00", current_earnings: "500.00", total_equity: "1400.00", total_liabilities_and_equity: "1600.00", difference: "0.00" },
  ];
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.body.current_cycle_id, "20");
  assert.deepEqual(result.body.assets, {
    accounts: [
      { id: "1", code: "1000", name: "Cash", balance: "1400.00" },
      { id: "2", code: "1100", name: "Loans receivable", balance: "200.00" },
    ],
    total: "1600.00",
  });
  assert.deepEqual(result.body.liabilities, {
    accounts: [{ id: "3", code: "2000", name: "Accounts payable", balance: "200.00" }],
    total: "200.00",
  });
  assert.deepEqual(result.body.equity, {
    accounts: [{ id: "4", code: "3000", name: "Equity", balance: "900.00" }],
    current_earnings: { income: "600.00", expenses: "100.00", balance: "500.00" },
    total: "1400.00",
  });
  assert.deepEqual(
    [result.body.total_assets, result.body.total_liabilities, result.body.total_equity,
      result.body.total_liabilities_and_equity, result.body.difference],
    ["1600.00", "200.00", "1400.00", "1600.00", "0.00"],
  );
});

test("balance sheet subtracts current-cycle losses from equity", async (t) => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "1", code: "1000", name: "Cash", type: "ASSET", balance: "200.00", total_assets: "200.00", total_liabilities: "150.00", equity_accounts_total: "100.00", income_total: "20.00", expense_total: "70.00", current_earnings: "-50.00", total_equity: "50.00", total_liabilities_and_equity: "200.00", difference: "0.00" },
    { id: "2", code: "2000", name: "Accounts payable", type: "LIABILITY", balance: "150.00", total_assets: "200.00", total_liabilities: "150.00", equity_accounts_total: "100.00", income_total: "20.00", expense_total: "70.00", current_earnings: "-50.00", total_equity: "50.00", total_liabilities_and_equity: "200.00", difference: "0.00" },
    { id: "3", code: "3000", name: "Equity", type: "EQUITY", balance: "100.00", total_assets: "200.00", total_liabilities: "150.00", equity_accounts_total: "100.00", income_total: "20.00", expense_total: "70.00", current_earnings: "-50.00", total_equity: "50.00", total_liabilities_and_equity: "200.00", difference: "0.00" },
    { id: "4", code: "4000", name: "Income", type: "INCOME", balance: "20.00", total_assets: "200.00", total_liabilities: "150.00", equity_accounts_total: "100.00", income_total: "20.00", expense_total: "70.00", current_earnings: "-50.00", total_equity: "50.00", total_liabilities_and_equity: "200.00", difference: "0.00" },
    { id: "5", code: "5000", name: "Expenses", type: "EXPENSE", balance: "70.00", total_assets: "200.00", total_liabilities: "150.00", equity_accounts_total: "100.00", income_total: "20.00", expense_total: "70.00", current_earnings: "-50.00", total_equity: "50.00", total_liabilities_and_equity: "200.00", difference: "0.00" },
  ];

  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.equity.current_earnings, {
    income: "20.00",
    expenses: "70.00",
    balance: "-50.00",
  });
  assert.equal(result.body.total_equity, "50.00");
  assert.equal(result.body.total_liabilities_and_equity, "200.00");
  assert.equal(result.body.difference, "0.00");
});

test("balance sheet rejects unauthorized callers and returns zero totals without an active cycle", async (t) => {
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
  assert.deepEqual(result.body.assets, { accounts: [], total: "0.00" });
  assert.deepEqual(result.body.liabilities, { accounts: [], total: "0.00" });
  assert.deepEqual(result.body.equity, {
    accounts: [],
    current_earnings: { income: "0.00", expenses: "0.00", balance: "0.00" },
    total: "0.00",
  });
  assert.equal(result.body.difference, "0.00");
});