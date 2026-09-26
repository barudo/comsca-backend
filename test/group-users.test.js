const { test } = require("node:test");
const assert = require("node:assert/strict");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture() {
  const state = { role: "OWNER", actorGroup: 1, authError: null, insertError: null, inserts: [], authCalls: 0 };
  const authId = "11111111-1111-4111-8111-111111111111";
  const db = table => {
    assert.equal(table, "groups");
    return { where: ({ slug }) => ({ first: async () =>
      slug === "alpha" ? { id: 1, slug } : slug === "beta" ? { id: 2, slug } : undefined,
    }) };
  };
  db.transaction = async callback => callback(table => {
    assert.equal(table, "users");
    return {
      where: where => ({ forUpdate: () => ({ first: async () => {
        assert.equal(where.auth_user_id, authId);
        return where.group_id === state.actorGroup ? { id: 10, role: state.role } : undefined;
      } }) }),
      insert: values => ({ returning: async columns => {
        if (state.insertError) throw state.insertError;
        assert.equal(columns.includes("password"), false);
        assert.equal(columns.includes("auth_user_id"), false);
        state.inserts.push(values);
        return [{ id: 20, ...values }];
      } }),
    };
  });
  const handler = serverless(createApp(db, { getUser: async ({ access_token }) => {
    state.authCalls++;
    assert.equal(access_token, "verified-token");
    if (state.authError) throw state.authError;
    // Untrusted metadata must not confer permissions.
    return { id: authId, user_metadata: { role: "OWNER", group_id: 2 } };
  } }));
  const post = async (body = { firstname: "Ana", lastname: "Cruz" }, options = {}) => {
    const response = await handler({ version: "2.0", rawPath: options.path || "/api/v1/user", rawQueryString: "",
      headers: { "content-type": "application/json", authorization: "Bearer verified-token",
        "x-group-slug": "alpha", ...options.headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
      body: JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers };
  };
  return { state, post };
}

test("OWNER and ADMIN create member profiles in the header's group at both route paths", async () => {
  const { state, post } = fixture();
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const path of ["/api/v1/user", "/api/v1/groups/users"]) {
      const result = await post({ firstname: " Ana ", lastname: " Cruz ", username: "ana",
        email: "ana@example.test", phone: "09171234567", address: "Main Street" }, { path });
      assert.equal(result.status, 201);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body.user, { id: 20, group_id: 1, first_name: "Ana", family_name: "Cruz",
        role: "MEMBER", username: "ana", email: "ana@example.test", phone: "+639171234567", address: "Main Street" });
      assert.equal("password" in state.inserts.at(-1), false);
      assert.equal("auth_user_id" in state.inserts.at(-1), false);
    }
  }
});

test("user creation rejects missing authentication, other groups, and unauthorized database roles", async () => {
  const { state, post } = fixture();
  for (const authorization of ["", "Basic token", "Bearer token extra"]) {
    assert.equal((await post(undefined, { headers: { authorization } })).status, 401);
  }
  assert.equal(state.authCalls, 0);
  assert.equal((await post(undefined, { headers: { "x-group-slug": "" } })).status, 400);
  assert.equal((await post(undefined, { headers: { "x-group-slug": "missing" } })).status, 404);
  assert.equal((await post(undefined, { headers: { "x-group-slug": "beta" } })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", null, "admin"]) {
    state.role = role;
    for (const path of ["/api/v1/user", "/api/v1/groups/users"]) assert.equal((await post(undefined, { path })).status, 403);
  }
  state.role = "OWNER";
  for (const status of [401, 429, 502, 503]) {
    state.authError = Object.assign(new Error("Authentication unavailable"), { status });
    assert.equal((await post()).status, status);
  }
  assert.equal(state.inserts.length, 0);
});

test("user creation validates input and rejects group, identity, and privilege overrides", async () => {
  const { state, post } = fixture();
  const valid = { firstname: "Ana", lastname: "Cruz" };
  for (const body of [null, [], {}, { ...valid, firstname: " " }, { ...valid, lastname: 123 },
    { ...valid, firstname: "a".repeat(256) }, { ...valid, email: "invalid" }, { ...valid, phone: "invalid" },
    { ...valid, group_id: 2 }, { ...valid, auth_user_id: "attacker" }, { ...valid, password: "secret" },
    { ...valid, role: "OWNER" }, { ...valid, role: "ADMIN" }, { ...valid, role: "TREASURER" },
    { ...valid, role: null }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(state.inserts.length, 0);
  state.insertError = Object.assign(new Error("Private constraint details"), { code: "23505" });
  assert.deepEqual((await post(valid)).body, { success: false, error: "User already exists in this group" });
  assert.equal((await post(valid)).status, 409);
  state.insertError = new Error("Private database details");
  assert.deepEqual((await post(valid)).body, { success: false, error: "Internal server error" });
  state.insertError = null;
  assert.equal((await post({ ...valid, role: "MEMBER" })).status, 201);
});
