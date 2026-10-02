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
    cycle: { id: "20" },
    queries: [],
    rows: [],
    statementQueries: [],
  };
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
      state.statementQueries.push(query);
      assert.match(query.sql, /FROM accounts a/);
      assert.match(query.sql, /a\.group_id = \? AND a\.cycle_id = \?/);
      assert.match(query.sql, /t\.cycle_id = a\.cycle_id/);
      assert.match(query.sql, /t\.group_id = e\.group_id/);
      assert.match(query.sql, /a\.type IN \('INCOME', 'EXPENSE'\)/);
      assert.match(
        query.sql,
        /section_totals AS \(\s*SELECT\s+COALESCE\(SUM\(amount\) FILTER \(WHERE type = 'INCOME'\), 0\.00\)/,
      );
      assert.doesNotMatch(query.sql, /SUM\(amount\).*OVER/);
      return { rows: state.rows };
    },
  });
  const handler = serverless(
    createApp(db, { getUser: async () => ({ id: "verified-user" }) }),
  );
  const get = async (query = "", headers = {}) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: "/api/v1/accounting/income-statement",
        rawQueryString: query,
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

test("income statement returns normal-side amounts and totals for current-cycle accounts", async (t) => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "1", code: "4000", name: "Interest income", type: "INCOME", amount: "37.40", total_income: "37.40", total_expenses: "10.00", net_income: "27.40" },
    { id: "2", code: "4200", name: "Other income", type: "INCOME", amount: "0.00", total_income: "37.40", total_expenses: "10.00", net_income: "27.40" },
    { id: "3", code: "5000", name: "Operating expenses", type: "EXPENSE", amount: "10.00", total_income: "37.40", total_expenses: "10.00", net_income: "27.40" },
    { id: "4", code: "5100", name: "Unused expenses", type: "EXPENSE", amount: "0.00", total_income: "37.40", total_expenses: "10.00", net_income: "27.40" },
  ];

  const result = await get("group_id=2&cycle_id=999");
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, "20");
  assert.deepEqual(result.body.income, {
    accounts: [
      { id: "1", code: "4000", name: "Interest income", amount: "37.40" },
      { id: "2", code: "4200", name: "Other income", amount: "0.00" },
    ],
    total: "37.40",
  });
  assert.deepEqual(result.body.expenses, {
    accounts: [
      { id: "3", code: "5000", name: "Operating expenses", amount: "10.00" },
      { id: "4", code: "5100", name: "Unused expenses", amount: "0.00" },
    ],
    total: "10.00",
  });
  assert.deepEqual(
    [result.body.total_income, result.body.total_expenses, result.body.net_income],
    ["37.40", "10.00", "27.40"],
  );
  assert.deepEqual(state.statementQueries[0].bindings, ["1", "20"]);
  assert.doesNotMatch(state.statementQueries[0].sql, /t\.occurred_at [<>]/);
});

test("income statement bounds occurred_at by inclusive Manila calendar dates", async (t) => {
  const { state, get } = fixture(t);
  const result = await get("from=2026-02-01&to=2026-02-03");
  assert.equal(result.status, 200);
  assert.match(state.statementQueries[0].sql, /t\.occurred_at >= \(\?::date::timestamp AT TIME ZONE 'Asia\/Manila'\)/);
  assert.match(state.statementQueries[0].sql, /t\.occurred_at < \(\(\?::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Manila'\)/);
  assert.deepEqual(state.statementQueries[0].bindings, [
    "2026-02-01",
    "2026-02-03",
    "1",
    "20",
  ]);

  assert.equal((await get("from=2024-02-29")).status, 200);
  assert.deepEqual(state.statementQueries[1].bindings, ["2024-02-29", "1", "20"]);
});

test("income statement accepts either date bound independently", async (t) => {
  const { state, get } = fixture(t);

  assert.equal((await get("from=2026-02-01")).status, 200);
  assert.match(state.statementQueries[0].sql, /t\.occurred_at >=/);
  assert.doesNotMatch(state.statementQueries[0].sql, /t\.occurred_at </);
  assert.deepEqual(state.statementQueries[0].bindings, ["2026-02-01", "1", "20"]);

  assert.equal((await get("to=2026-02-03")).status, 200);
  assert.doesNotMatch(state.statementQueries[1].sql, /t\.occurred_at >=/);
  assert.match(state.statementQueries[1].sql, /t\.occurred_at </);
  assert.deepEqual(state.statementQueries[1].bindings, ["2026-02-03", "1", "20"]);
});

test("invalid dates and reversed ranges return 400 without reading statement rows", async (t) => {
  const { state, get } = fixture(t);
  for (const query of [
    "from=2026-02-30",
    "from=2025-02-29",
    "to=02-28-2026",
    "from=2026-03-02&to=2026-03-01",
  ]) {
    const result = await get(query);
    assert.equal(result.status, 400);
    assert.equal(state.statementQueries.length, 0);
  }
});

test("income statement authorizes financial roles and returns empty totals without a current cycle", async (t) => {
  const { state, get } = fixture(t);
  assert.equal((await get("", { authorization: "" })).status, 401);
  assert.equal((await get("", { "x-group-slug": "beta" })).status, 403);
  assert.equal(state.statementQueries.length, 0);

  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
    state.role = role;
    assert.equal((await get()).status, 200);
  }
  state.queries.length = 0;
  state.statementQueries.length = 0;
  state.role = "MEMBER";
  assert.equal((await get()).status, 403);
  assert.equal(state.statementQueries.length, 0);
  assert.equal(state.queries.some((query) => query.sql.includes('from "cycles"')), false);

  state.role = "OWNER";
  state.cycle = undefined;
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.current_cycle_id, null);
  assert.deepEqual(result.body.income, { accounts: [], total: "0.00" });
  assert.deepEqual(result.body.expenses, { accounts: [], total: "0.00" });
  assert.deepEqual(
    [result.body.total_income, result.body.total_expenses, result.body.net_income],
    ["0.00", "0.00", "0.00"],
  );
  assert.equal(state.statementQueries.length, 0);
});
