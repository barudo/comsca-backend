const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = {
    profile: true,
    cycle: { id: "20" },
    entries: [
      {
        id: "101",
        group_id: "1",
        transaction_id: "51",
        user_id: "11",
        cycle_id: "20",
        type: "BUY_SHARE",
        amount: "100.00",
        description: "Current cycle share",
        created_at: "2026-10-01T12:00:00.000Z",
        updated_at: "2026-10-01T12:00:00.000Z",
        transaction_occurred_at: "2026-10-01T12:00:00.000Z",
      },
      {
        id: "102",
        group_id: "1",
        transaction_id: "52",
        user_id: "11",
        cycle_id: "20",
        type: "LOAN_DISBURSED",
        amount: "500.00",
        description: "Legacy loan entry",
        created_at: "2026-10-01T11:00:00.000Z",
        updated_at: "2026-10-01T11:00:00.000Z",
        transaction_occurred_at: "2026-10-01T11:00:00.000Z",
      },
      {
        id: "103",
        group_id: "1",
        transaction_id: "40",
        user_id: "11",
        cycle_id: "15",
        type: "BUY_SHARE",
        amount: "900.00",
        description: "Historical cycle share",
        created_at: "2026-09-01T12:00:00.000Z",
        updated_at: "2026-09-01T12:00:00.000Z",
        transaction_occurred_at: "2026-09-01T12:00:00.000Z",
      },
    ],
    queries: [],
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
      if (query.sql.startsWith("SET TRANSACTION")) return {};
      if (query.sql.includes('from "users"')) {
        assert.equal(query.bindings[0], "verified-user");
        return query.bindings[1] === "1" && state.profile
          ? { id: "11" }
          : undefined;
      }
      if (query.sql.includes('from "cycles"')) {
        assert.deepEqual(query.bindings, ["1", "active", "distributing", 1]);
        assert.match(query.sql, /order by "created_at" desc, "id" desc/);
        return state.cycle;
      }
      assert.match(query.sql, /FROM transaction_entries e/);
      assert.match(query.sql, /JOIN transactions t ON t\.id = e\.transaction_id AND t\.group_id = e\.group_id/);
      assert.match(query.sql, /e\.group_id = \? AND t\.group_id = \?/);
      assert.match(query.sql, /COALESCE\(e\.user_id, t\.user_id\) = \?/);
      assert.match(query.sql, /t\.cycle_id = \?/);
      assert.match(query.sql, /t\.status = 'active'/);
      assert.match(query.sql, /COALESCE\(e\.cycle_id, t\.cycle_id\) AS cycle_id/);
      assert.match(query.sql, /t\.occurred_at AS transaction_occurred_at/);
      assert.match(query.sql, /ORDER BY t\.occurred_at ASC, t\.id ASC, e\.id ASC/);
      assert.deepEqual(query.bindings, ["1", "1", "11", "20"]);
      return {
        rows: state.entries
          .filter((entry) => entry.cycle_id === state.cycle.id)
          .sort((left, right) =>
            left.transaction_occurred_at.localeCompare(right.transaction_occurred_at),
          ),
      };
    },
  });
  const handler = serverless(
    createApp(db, {
      getUser: async () => ({ id: "verified-user" }),
    }),
  );
  const get = async (headers = {}) => {
    const result = await handler(
      {
        version: "2.0",
        rawPath: "/api/v1/me/transactions",
        rawQueryString: "group_id=2&user_id=99&cycle_id=999",
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

test("GET current-user transactions returns only active-cycle entries oldest first", async (t) => {
  const { state, get } = fixture(t);
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.body, {
    success: true,
    data: state.entries
      .filter((entry) => entry.cycle_id === state.cycle.id)
      .sort((left, right) =>
        left.transaction_occurred_at.localeCompare(right.transaction_occurred_at),
      ),
  });
  assert.ok(result.body.data.every((entry) => entry.cycle_id === "20"));
});

test("current-user transactions require authentication and selected-group membership", async (t) => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  assert.equal((await get({ "x-group-slug": "" })).status, 400);
  assert.equal((await get({ "x-group-slug": "unknown" })).status, 404);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  state.profile = false;
  const result = await get();
  assert.equal(result.status, 403);
  assert.equal(
    state.queries.some((query) => query.sql.includes("FROM transaction_entries e")),
    false,
  );
});

test("current-user transactions return an empty data array when there is no active cycle", async (t) => {
  const { state, get } = fixture(t);
  state.cycle = undefined;
  const result = await get();
  assert.deepEqual(result.body, { success: true, data: [] });
  assert.equal(
    state.queries.some((query) => query.sql.includes("FROM transaction_entries e")),
    false,
  );
});
