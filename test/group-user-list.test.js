const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const authId = "11111111-1111-4111-8111-111111111111";
  const state = { role: "OWNER", cycle: { id: "7" }, authError: null, dbError: null, queries: [] };
  Object.defineProperty(db, "transaction", { value: async callback => callback(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    state.queries.push(query);
    if (query.sql === "SET LOCAL ROLE comsca_group_reader") return {};
    if (query.sql.includes("set_config")) {
      assert.deepEqual(query.bindings, ["1"]);
      return {};
    }
    if (query.sql.includes('from "groups"')) {
      return query.bindings[0] === "alpha" ? { id: "1", slug: "alpha" } :
        query.bindings[0] === "beta" ? { id: "2", slug: "beta" } : undefined;
    }
    if (query.sql.includes('from "users" where')) {
      assert.deepEqual(query.bindings, [authId, query.bindings[1], 1]);
      return query.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    if (state.dbError) throw state.dbError;
    if (query.sql.includes('from "cycles"')) {
      assert.match(query.sql, /where "group_id" = \? and "status" <> \?/);
      assert.deepEqual(query.bindings, ["1", "closed", 1]);
      return state.cycle;
    }
    assert.match(query.sql, /left join "cycle_members" as "cm" on "cm"\."user_id" = "u"\."id" and "cm"\."cycle_id" = \?/);
    assert.match(query.sql, /where "u"\."group_id" = \?/);
    assert.match(query.sql, /cm.user_id IS NOT NULL AS is_current_cycle_member/);
    assert.doesNotMatch(query.sql, /password|auth_user_id|select \*/);
    assert.deepEqual(query.bindings, [state.cycle?.id ?? null, "1"]);
    return [{ id: "10", is_current_cycle_member: !!state.cycle }, { id: "11", is_current_cycle_member: false }];
  } });
  const handler = serverless(createApp(db, { getUser: async () => {
    if (state.authError) throw state.authError;
    return { id: authId };
  } }));
  const get = async (path = "/api/v1/groups/users", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: path, rawQueryString: "group_id=2&cycle_id=999",
      headers: { authorization: "Bearer verified-token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, get };
}

test("group user list scopes membership to the selected group's non-closed current cycle on the versioned path", async t => {
  const { state, get } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const path of ["/api/v1/groups/users"]) {
      const result = await get(path);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, current_cycle_id: "7", users: [
        { id: "10", is_current_cycle_member: true }, { id: "11", is_current_cycle_member: false },
      ] });
    }
  }
  state.cycle = undefined;
  assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, users: [
    { id: "10", is_current_cycle_member: false }, { id: "11", is_current_cycle_member: false },
  ] });
});

test("group user list denies unauthenticated, cross-group, and non-manager access before listing", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get(undefined, { authorization: "" })).status, 401);
  assert.equal((await get(undefined, { "x-group-slug": "" })).status, 400);
  assert.equal((await get(undefined, { "x-group-slug": "unknown" })).status, 404);
  for (const path of ["/api/v1/groups/users"]) {
    assert.equal((await get(path, { "x-group-slug": "beta" })).status, 403);
    for (const role of ["MEMBER", "TREASURER", "AUDITOR", null]) {
      state.role = role;
      assert.equal((await get(path)).status, 403);
    }
  }
  state.authError = Object.assign(new Error("Invalid token"), { status: 401 });
  assert.equal((await get()).status, 401);
  assert.equal(state.queries.some(query => query.sql.includes('from "cycles"')), false);
});

test("group user list hides database failure details", async t => {
  const { state, get } = fixture(t);
  state.dbError = new Error("Private database details");
  const result = await get();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, error: "Internal server error" });
});
