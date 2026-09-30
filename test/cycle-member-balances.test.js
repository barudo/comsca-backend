const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: { id: "20" }, queries: [], error: null, invalidToken: false };
  const members = [{ id: "11", group_id: "1", first_name: "Ana", family_name: "Doe",
    total_shares: "9007199254740993.99", remaining_loan: "100.01", unpaid_penalties: "-1.00", unpaid_contributions: "0.00" }];
  Object.defineProperty(db, "transaction", { value: async fn => {
    const result = await fn(db);
    if (state.commitError) throw state.commitError;
    return result;
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return q.bindings[0] === "alpha" ? { id: "1" } : q.bindings[0] === "beta" ? { id: "2" } : undefined;
    if (q.sql.startsWith("SET TRANSACTION")) {
      assert.equal(q.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"); return {};
    }
    if (q.sql.includes('from "users"')) {
      assert.deepEqual(q.bindings, ["verified-user", q.bindings[1], 1]);
      return q.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    if (state.error) throw state.error;
    if (q.sql.includes('from "cycles"')) {
      assert.deepEqual(q.bindings, ["1", "active", "distributing", 1]);
      assert.match(q.sql, /order by "created_at" desc, "id" desc/);
      return state.cycle;
    }
    assert.match(q.sql, /JOIN cycle_members cm ON cm.user_id = u.id AND cm.cycle_id = \?/);
    assert.match(q.sql, /WHERE e.group_id = \? AND t.group_id = \? AND t.cycle_id = \?/);
    assert.match(q.sql, /WHERE u.group_id = \?/);
    assert.match(q.sql, /ORDER BY u.family_name, u.first_name, u.id/);
    assert.match(q.sql, /COALESCE\(e.user_id, t.user_id\)/);
    assert.match(q.sql, /LOAN_INTEREST/);
    assert.doesNotMatch(q.sql, /account_entries|password|auth_user_id|SELECT \*/i);
    assert.deepEqual(q.bindings, ["20", "1", "1", "20", "1"]);
    return { rows: members };
  } });
  const handler = serverless(createApp(db, { getUser: async () => {
    if (state.invalidToken) throw Object.assign(new Error("Invalid access token"), { status: 401 });
    return { id: "verified-user", user_metadata: { role: "OWNER" } };
  } }));
  const get = async (headers = {}, path = "/api/v1/cylces/members") => {
    const result = await handler({ version: "2.0", rawPath: path, rawQueryString: "group_id=2&cycle_id=999",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, members, get };
}

test("both member balance routes return exact strings for all financial roles", async t => {
  const { state, members, get } = fixture(t);
  for (const path of ["/api/v1/cylces/members", "/api/v1/cycles/members"]) {
    for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
      state.role = role;
      const result = await get({}, path);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, current_cycle_id: "20", members });
    }
  }
});

test("no eligible cycle returns an empty roster without querying ledger", async t => {
  const { state, get } = fixture(t);
  state.cycle = undefined;
  assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, members: [] });
  assert.equal(state.queries.some(q => q.sql.includes("transaction_entries")), false);
});

test("member balances require authentication and a financial role in the selected group", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  state.invalidToken = true;
  assert.equal((await get()).status, 401);
  state.invalidToken = false;
  assert.equal((await get({ "x-group-slug": "" })).status, 400);
  assert.equal((await get({ "x-group-slug": "unknown" })).status, 404);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", null, "owner"]) {
    state.role = role;
    assert.equal((await get()).status, 403);
  }
  assert.equal(state.queries.some(q => q.sql.includes('from "cycles"') || q.sql.includes("transaction_entries")), false);
});

test("member balance query and commit errors are sanitized", async t => {
  const { state, get } = fixture(t);
  for (const stage of ["error", "commitError"]) {
    state[stage] = new Error("private ledger failure");
    const result = await get();
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: "Internal server error" });
    state[stage] = null;
  }
});
