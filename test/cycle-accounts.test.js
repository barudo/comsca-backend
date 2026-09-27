const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: { id: "20" }, queries: [], error: null };
  const accounts = [{ id: "100", group_id: "1", cycle_id: "20", code: "1000", name: "Cash", type: "ASSET" }];
  Object.defineProperty(db, "transaction", { value: async fn => fn(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL(); state.queries.push(query);
    if (query.sql.includes('from "groups"')) return query.bindings[0] === "alpha" ? { id: "1" } : query.bindings[0] === "beta" ? { id: "2" } : undefined;
    if (query.sql.includes('from "users"')) {
      assert.deepEqual(query.bindings, ["verified-user", query.bindings[1], 1]);
      assert.match(query.sql, /for share/);
      return query.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    if (query.sql === "SET LOCAL ROLE comsca_group_reader") return {};
    if (query.sql.includes("set_config")) { assert.deepEqual(query.bindings, ["1"]); return {}; }
    if (state.error) throw state.error;
    if (query.sql.includes('from "cycles"')) {
      assert.deepEqual(query.bindings, ["1", "draft", "active", "distributing", 1]);
      return state.cycle;
    }
    assert.match(query.sql, /from "accounts" where "group_id" = \? and "cycle_id" = \? order by "code" asc, "id" asc/);
    assert.deepEqual(query.bindings, ["1", "20"]);
    assert.doesNotMatch(query.sql, /select \*/);
    return accounts;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "verified-user", user_metadata: { role: "OWNER" } }) }));
  const get = async (headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: "/api/v1/cycles/accounts",
      rawQueryString: "group_id=2&cycle_id=999",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, accounts, get };
}

test("GET cycle accounts scopes to verified group/current cycle for financial roles", async t => {
  const { state, accounts, get } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
    state.role = role;
    const result = await get();
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.body, { success: true, current_cycle_id: "20", accounts });
  }
  state.cycle = undefined;
  assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, accounts: [] });
});

test("GET cycle accounts rejects unauthenticated, non-financial and cross-group callers", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  assert.equal((await get({ "x-group-slug": "" })).status, 400);
  assert.equal((await get({ "x-group-slug": "unknown" })).status, 404);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", null, "owner"]) {
    state.role = role;
    assert.equal((await get()).status, 403);
  }
  assert.equal(state.queries.some(q => q.sql.includes('from "accounts"') || q.sql.includes('from "cycles"')), false);
});

test("GET cycle accounts hides database errors", async t => {
  const { state, get } = fixture(t);
  state.error = new Error("private database error");
  assert.deepEqual((await get()).body, { success: false, error: "Internal server error" });
});
