const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", updates: [], error: null, user: {
    id: "20", group_id: 1, first_name: "Ana", family_name: "Cruz", role: "MEMBER",
    phone: "+639171234567", email: "ana@example.test", address: "Main Street", username: "ana",
  } };
  Object.defineProperty(db, "transaction", { value: async callback => callback(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    if (query.sql.includes('from "groups"')) return query.bindings[0] === "alpha" ? { id: 1 } : query.bindings[0] === "beta" ? { id: 2 } : undefined;
    if (query.sql.startsWith("select")) {
      assert.match(query.sql, /where "auth_user_id" = \? and "group_id" = \? limit \? for update$/);
      assert.deepEqual(query.bindings, ["auth-id", query.bindings[1], 1]);
      return query.bindings[1] === 1 ? { id: "10", role: state.role } : undefined;
    }
    assert.match(query.sql, /^update "users"/);
    assert.match(query.sql, /where "id" = \? and "group_id" = \? returning/);
    assert.equal(query.returning.includes("password"), false);
    assert.equal(query.returning.includes("auth_user_id"), false);
    const [id, group] = query.bindings.slice(-2);
    if (state.error) throw state.error;
    if (id !== state.user.id || group !== state.user.group_id) return [];
    const { updated_at, ...values } = builder._single.update;
    assert.equal(updated_at.toSQL().sql, "clock_timestamp()");
    state.updates.push(values);
    state.user = { ...state.user, ...values, updated_at: "2026-09-25T00:00:00Z" };
    return [state.user];
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-id", user_metadata: { role: "OWNER" } }) }));
  const put = async (body, options = {}) => {
    const response = await handler({ version: "2.0", rawPath: options.path || "/api/v1/groups/users/20",
      rawQueryString: "group_id=2", headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "alpha", ...options.headers },
      requestContext: { http: { method: "PUT", sourceIp: "127.0.0.1" } }, body: JSON.stringify(body) }, {});
    return { status: response.statusCode, body: response.headers["content-type"]?.includes("application/json") ? JSON.parse(response.body) : response.body };
  };
  return { state, put };
}

test("OWNER/ADMIN update group profiles, normalize fields, preserve omissions and clear optional fields", async t => {
  const { state, put } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    const result = await put({ firstname: " Maria ", phone: "09181234567" });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.user.first_name, "Maria");
    assert.equal(result.body.user.phone, "+639181234567");
    assert.equal(result.body.user.family_name, "Cruz");
    assert.equal(result.body.user.role, "MEMBER");
    assert.deepEqual(state.updates.at(-1), { first_name: "Maria", phone: "+639181234567" });
  }
  assert.equal((await put({ username: null, email: null, phone: null, address: null })).status, 200);
  for (const field of ["username", "email", "phone", "address"]) assert.equal(state.user[field], null);
});

test("user updates enforce authentication, authorization, group isolation and versioned routing", async t => {
  const { state, put } = fixture(t);
  const body = { firstname: "Maria" };
  assert.equal((await put(body, { headers: { authorization: "" } })).status, 401);
  assert.equal((await put(body, { headers: { "x-group-slug": "" } })).status, 400);
  assert.equal((await put(body, { headers: { "x-group-slug": "missing" } })).status, 404);
  assert.equal((await put(body, { headers: { "x-group-slug": "beta" } })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", null]) {
    state.role = role;
    assert.equal((await put(body)).status, 403);
  }
  state.role = "OWNER";
  state.user.group_id = 2;
  assert.equal((await put(body)).status, 404);
  assert.equal((await put(body, { path: "/api/v1/groups/users/21" })).status, 404);
  assert.equal((await put(body, { path: "/groups/users/20" })).status, 404);
  assert.equal(state.updates.length, 0);
});

test("user updates reject invalid IDs and payloads without writes and hide database errors", async t => {
  const { state, put } = fixture(t);
  for (const id of ["0", "01", "-1", "1.5", "abc", "9223372036854775808"]) {
    assert.equal((await put({ firstname: "Ana" }, { path: `/api/v1/groups/users/${id}` })).status, 400);
  }
  for (const body of [null, [], {}, "user", { firstname: null }, { lastname: " " },
    { firstname: "x".repeat(256) }, { firstname: "bad\u0000name" }, { phone: "invalid" }, { email: "invalid" },
    { address: 12 }, { role: "MEMBER" }, { role: "OWNER" }, { group_id: 2 }, { id: 30 },
    { auth_user_id: "id" }, { password: "secret" }, { updated_at: "today" }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(state.updates.length, 0);
  state.error = Object.assign(new Error("private constraint"), { code: "23505" });
  assert.equal((await put({ username: "duplicate" })).status, 409);
  state.error = new Error("private database details");
  assert.deepEqual((await put({ firstname: "Ana" })).body, { success: false, error: "Internal server error" });
});
