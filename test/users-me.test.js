const { test } = require("node:test");
const assert = require("node:assert/strict");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture() {
  const authId = "11111111-1111-4111-8111-111111111111";
  const user = { id: 10, group_id: 1, first_name: "Ana", family_name: "Cruz", username: null,
    email: null, phone: "+639171234567", address: null, role: "MEMBER",
    created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z",
    password: "private-hash", auth_user_id: authId };
  const state = { user, authError: null, dbError: null, missingProfile: false, authCalls: 0, profileCalls: 0 };
  const handler = serverless(createApp(table => ({ where: where => ({ first: async (...columns) => {
    if (table === "groups") {
      if (where.slug === "alpha") return { id: 1, name: "Alpha", slug: "alpha", private_field: "hidden" };
      if (where.slug === "beta") return { id: 2, name: "Beta", slug: "beta" };
      return undefined;
    }
    assert.equal(table, "users");
    state.profileCalls++;
    assert.equal(where.auth_user_id, authId);
    assert.deepEqual(Object.keys(where).sort(), ["auth_user_id", "group_id"]);
    assert.equal(columns.includes("password"), false);
    assert.equal(columns.includes("auth_user_id"), false);
    if (state.dbError) throw state.dbError;
    if (state.missingProfile || where.group_id !== user.group_id) return undefined;
    return Object.fromEntries(columns.map(column => [column, user[column]]));
  } }) }), { getUser: async ({ access_token }) => {
    assert.equal(access_token, "verified-token");
    state.authCalls++;
    if (state.authError) throw state.authError;
    return { id: authId, user_metadata: { role: "OWNER", group_id: 2 } };
  } }));
  const get = async (path = "/users/me", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: path, rawQueryString: "user_id=999&group_id=2",
      headers: { authorization: "Bearer verified-token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, get };
}

test("GET /users/me returns the caller's database profile for every group role", async () => {
  const { state, get } = fixture();
  for (const role of ["OWNER", "ADMIN", "TREASURER", "MEMBER", "AUDITOR"]) {
    state.user.role = role;
    for (const path of ["/users/me", "/api/v1/users/me"]) {
      const result = await get(path);
      const { password, auth_user_id, ...expected } = state.user;
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, user: expected, group: { id: 1, name: "Alpha", slug: "alpha" } });
    }
  }
});

test("GET /users/me requires authentication and the caller's group membership", async () => {
  const { state, get } = fixture();
  for (const authorization of ["", "Basic token", "Bearer token extra"]) {
    assert.equal((await get(undefined, { authorization })).status, 401);
  }
  assert.equal(state.authCalls, 0);
  assert.equal((await get(undefined, { "x-group-slug": "" })).status, 400);
  assert.equal((await get(undefined, { "x-group-slug": "unknown" })).status, 404);
  assert.equal((await get(undefined, { "x-group-slug": "beta" })).status, 403);
  state.missingProfile = true;
  assert.equal((await get()).status, 403);
  state.missingProfile = false;
  const calls = state.profileCalls;
  for (const status of [401, 429, 502, 503]) {
    state.authError = Object.assign(new Error("Authentication unavailable"), { status });
    assert.equal((await get()).status, status);
  }
  assert.equal(state.profileCalls, calls);
});

test("GET /users/me does not expose database errors", async () => {
  const { state, get } = fixture();
  state.dbError = new Error("Private database details");
  const result = await get();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, error: "Internal server error" });
  state.dbError.code = "ECONNREFUSED";
  assert.equal((await get()).status, 503);
});
