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
    totals: {
      cash_on_hand: "9007199254740993.99",
      outstanding_loans: "100.01",
      total_fund_value: "9007199254741194.00",
      share_capital: "300.25",
      contributions_collected: "40.10",
      contributions_due: "59.90",
      active_members: 2,
    },
    queries: [],
    invalidToken: false,
  };
  Object.defineProperty(db, "transaction", {
    value: async (fn) => fn(db),
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
      if (query.sql.startsWith("SET TRANSACTION")) {
        assert.equal(
          query.sql,
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        return {};
      }
      if (query.sql.includes('from "users"')) {
        assert.deepEqual(query.bindings, ["verified-user", query.bindings[1], 1]);
        return query.bindings[1] === "1"
          ? { id: "10", role: state.role }
          : undefined;
      }
      if (query.sql.includes('from "cycles"')) {
        assert.deepEqual(query.bindings, ["1", "active", "distributing", 1]);
        assert.match(query.sql, /order by "created_at" desc, "id" desc/);
        return state.cycle;
      }
      assert.match(query.sql, /a\.group_id = \? AND a\.cycle_id = \?/);
      assert.match(query.sql, /e\.group_id = \? AND t\.group_id = \? AND t\.cycle_id = \?/);
      assert.match(query.sql, /cm\.cycle_id = \?/);
      assert.match(
        query.sql,
        /SUM\(e\.amount\) FILTER \(WHERE e\.type IN \('LOAN_DISBURSED', 'LOAN_DISBURSEMENT', 'LOAN_INTEREST'\)\)/,
      );
      assert.match(
        query.sql,
        /SUM\(e\.amount\) FILTER \(WHERE e\.type = 'LOAN_PAYMENT'\)/,
      );
      assert.match(
        query.sql,
        /SUM\(e\.amount\) FILTER \(WHERE e\.type = 'BUY_SHARE'\)/,
      );
      assert.match(
        query.sql,
        /SUM\(e\.amount\) FILTER \(WHERE e\.type = 'PAY_CONTRIBUTION'\)/,
      );
      assert.match(
        query.sql,
        /SUM\(e\.amount\) FILTER \(WHERE e\.type IN \('CHARGE_CONTRIBUTION', 'CONTRIBUTION'\)\)/,
      );
      assert.match(query.sql, /SUM\(balance\) FROM scoped_accounts WHERE type = 'ASSET'/);
      assert.match(query.sql, /COUNT\(\*\)::int AS active_members/);
      for (const field of [
        "cash_on_hand",
        "total_fund_value",
        "outstanding_loans",
        "share_capital",
        "contributions_collected",
        "contributions_due",
      ]) {
        assert.match(query.sql, new RegExp(`::text AS ${field}`));
      }
      assert.doesNotMatch(query.sql, /group_id=2|cycle_id=999|SELECT \*/i);
      assert.deepEqual(query.bindings, ["1", "20", "1", "1", "20", "1", "20"]);
      return { rows: [state.totals] };
    },
  });
  const handler = serverless(
    createApp(db, {
      getUser: async () => {
        if (state.invalidToken) {
          throw Object.assign(new Error("Invalid access token"), { status: 401 });
        }
        return { id: "verified-user", user_metadata: { role: "OWNER" } };
      },
    }),
  );
  const get = async (headers = {}) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: "/api/v1/dashboard",
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

test("dashboard returns exact current-cycle totals for financial reader roles", async (t) => {
  const { state, get } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
    state.role = role;
    const result = await get();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      success: true,
      current_cycle_id: "20",
      ...state.totals,
    });
  }
});

test("dashboard returns zero totals and null cycle when there is no active cycle", async (t) => {
  const { state, get } = fixture(t);
  state.cycle = undefined;
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    current_cycle_id: null,
    cash_on_hand: "0.00",
    outstanding_loans: "0.00",
    total_fund_value: "0.00",
    share_capital: "0.00",
    contributions_collected: "0.00",
    contributions_due: "0.00",
    active_members: 0,
  });
  assert.equal(
    state.queries.some((query) => query.sql.includes("transaction_entries")),
    false,
  );
});

test("dashboard rejects unauthenticated and non-financial cross-group callers", async (t) => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  state.invalidToken = true;
  assert.equal((await get()).status, 401);
  state.invalidToken = false;
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", null, "owner"]) {
    state.role = role;
    assert.equal((await get()).status, 403);
  }
  assert.equal(
    state.queries.some(
      (query) =>
        query.sql.includes('from "cycles"') ||
        query.sql.includes("transaction_entries"),
    ),
    false,
  );
});
