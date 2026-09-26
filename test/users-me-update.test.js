const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t, services = {}) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { writes: [], passwords: [], missing: false, error: null, authError: null, passwordError: null,
    user: { id: 10, group_id: 1, first_name: "Ana", family_name: "Cruz", address: "Main Street",
      phone: "+639171234567", role: "MEMBER", password: "private-hash", auth_user_id: "auth-id" } };
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    if (query.sql.includes('from "groups"')) {
      return query.bindings[0] === "alpha" ? { id: 1, name: "Alpha", slug: "alpha" } :
        query.bindings[0] === "beta" ? { id: 2, name: "Beta", slug: "beta" } : undefined;
    }
    assert.match(query.sql, /where "auth_user_id" = \? and "group_id" = \?/);
    const bindings = query.method === "first" ? query.bindings.slice(0, -1) : query.bindings;
    assert.deepEqual(bindings.slice(-2), ["auth-id", bindings.at(-1)]);
    if (state.error) throw state.error;
    if (state.missing || bindings.at(-1) !== 1) return query.method === "first" ? undefined : [];
    if (query.method === "first") return { id: 10 };
    assert.equal(query.method, "update");
    assert.equal(query.returning.includes("password"), false);
    assert.equal(query.returning.includes("auth_user_id"), false);
    const { updated_at, ...values } = builder._single.update;
    assert.equal(updated_at.toSQL().sql, "clock_timestamp()");
    state.writes.push(values);
    Object.assign(state.user, values, { updated_at: "2026-09-26T00:00:00Z" });
    return [Object.fromEntries(query.returning.map(key => [key, state.user[key]]))];
  } });
  const handler = serverless(createApp(db, {
    getUser: async () => { if (state.authError) throw state.authError; return { id: "auth-id" }; },
    updatePassword: async input => { if (state.passwordError) throw state.passwordError; state.passwords.push(input); },
    ...services,
  }));
  const put = async (body, password = false, headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: `/api/v1/users/me${password ? "/password" : ""}`,
      rawQueryString: "user_id=99&group_id=2", headers: { authorization: "Bearer verified-token",
        "content-type": "application/json", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "PUT", sourceIp: "127.0.0.1" } }, body: headers["x-test-malformed"] ? "{" : JSON.stringify(body) }, {});
    assert.equal(result.headers["cache-control"], "no-store");
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, put };
}
const passwordBody = value => ({ new_password: value, repeat_new_password: value });

test("all roles can update their own allowed profile fields with safe responses", async t => {
  const { state, put } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "MEMBER", "TREASURER", "AUDITOR"]) {
    state.user.role = role;
    const result = await put({ first_name: " Maria ", family_name: " Santos ", address: " New Street " });
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(state.writes.at(-1), { first_name: "Maria", family_name: "Santos", address: "New Street" });
    assert.equal(result.body.user.phone, "+639171234567");
    assert.equal(result.body.user.role, role);
    assert.equal(result.body.user.password, undefined);
    assert.equal(result.body.user.auth_user_id, undefined);
    assert.deepEqual(result.body.group, { id: 1, name: "Alpha", slug: "alpha" });
  }
  assert.equal((await put({ address: null })).status, 200);
  assert.equal(state.user.address, null);
  assert.equal(state.user.first_name, "Maria");
  assert.equal((await put({ first_name: "x".repeat(255), address: "x".repeat(4000) })).status, 200);
  assert.equal((await put({ first_name: "😀".repeat(255) })).status, 200);
  assert.equal(state.user.password, "private-hash");
  assert.equal(state.passwords.length, 0);
});

test("profile validation rejects prohibited fields and malformed values without mutation", async t => {
  const { state, put } = fixture(t);
  for (const body of [null, [], {}, "text", { first_name: null }, { family_name: " " },
    { first_name: "x".repeat(256) }, { family_name: "x\u0000y" }, { address: 1 }, { address: " " },
    { address: "x".repeat(4001) }, { first_name: "\ud800" }, { first_name: "😀".repeat(256) },
    ...["phone", "password", "new_password", "role", "id", "group_id",
      "auth_user_id", "email", "username", "updated_at"].map(field => ({ first_name: "Valid", [field]: "forbidden" }))]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(state.writes.length, 0);
});

test("both updates enforce token authentication and selected group membership", async t => {
  const { state, put } = fixture(t);
  for (const password of [false, true]) {
    const body = password ? passwordBody("new-password") : { first_name: "Maria" };
    assert.equal((await put(body, password, { "x-test-malformed": "true" })).status, 400);
    for (const authorization of ["", "Basic token", "Bearer token extra"]) {
      assert.equal((await put(body, password, { authorization })).status, 401);
    }
    for (const [slug, expected] of [["", 400], ["unknown", 404], ["beta", 403]]) {
      assert.equal((await put(body, password, { "x-group-slug": slug })).status, expected);
    }
    state.missing = true;
    assert.equal((await put(body, password)).status, 403);
    state.missing = false;
    state.authError = Object.assign(new Error("Invalid session"), { status: 401 });
    assert.equal((await put(body, password)).status, 401);
    state.authError = null;
    state.error = new Error("private database detail");
    assert.deepEqual((await put(body, password)).body, { success: false, error: "Internal server error" });
    state.error = null;
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.passwords.length, 0);
});

test("password updates validate confirmation and byte limits, preserve exact passwords and never write local hashes", async t => {
  const { state, put } = fixture(t);
  for (const body of [null, [], {}, passwordBody(123), passwordBody("short"), passwordBody("x".repeat(73)),
    passwordBody("é".repeat(37)), passwordBody("😀".repeat(4)), passwordBody("password\ud800"),
    { new_password: "new-password" }, { repeat_new_password: "new-password" },
    { new_password: "new-password", repeat_new_password: "different" },
    { ...passwordBody("new-password"), password: "forbidden" }, { ...passwordBody("new-password"), phone: "forbidden" }]) {
    assert.equal((await put(body, true)).status, 400);
  }
  assert.equal(state.passwords.length, 0);
  for (const value of ["12345678", "x".repeat(72), "é".repeat(36), "😀".repeat(8), " spaced password "]) {
    const result = await put(passwordBody(value), true);
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.body, { success: true, message: "Password updated successfully" });
    assert.deepEqual(state.passwords.at(-1), { access_token: "verified-token", password: value });
  }
  for (const status of [400, 401, 403, 429, 502, 503]) {
    state.passwordError = Object.assign(new Error("Safe provider error"), { status });
    assert.equal((await put(passwordBody("new-password"), true)).status, status);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.user.password, "private-hash");
});

test("Supabase password update uses the caller token and sanitizes policy and transport errors", async t => {
  const { updatePassword } = require("../src/services/supabase-auth");
  const old = [process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY];
  process.env.SUPABASE_URL = "https://example.supabase.co/";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
  t.after(() => {
    for (const [i, key] of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"].entries()) {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    }
  });
  let status = 200, code, brokenJson = false, network = false, malformed = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://example.supabase.co/auth/v1/user");
    assert.equal(options.method, "PUT");
    assert.equal(options.headers.Authorization, "Bearer verified-token");
    assert.equal(options.headers.apikey, "publishable-key");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { password: "new-password" });
    if (network) throw new Error("private network detail");
    return { status, ok: status === 200, json: async () => {
      if (brokenJson) throw new Error("private upstream body");
      return malformed ? {} : { id: "11111111-1111-4111-8111-111111111111", code, message: "private provider detail" };
    } };
  });
  const { put } = fixture(t, { updatePassword });
  assert.equal((await put(passwordBody("new-password"), true)).status, 200);
  for (const [http, errorCode, expected] of [[422, "weak_password", 400], [422, "same_password", 400],
    [400, "reauthentication_needed", 403], [400, "reauthentication_not_valid", 403],
    [400, "current_password_required", 403],
    [401, "bad_jwt", 401], [429, "over_request_rate_limit", 429], [500, "unexpected_failure", 502],
    [400, "validation_failed", 400]]) {
    status = http; code = errorCode;
    const result = await put(passwordBody("new-password"), true);
    assert.equal(result.status, expected);
    assert.equal(JSON.stringify(result.body).includes("private"), false);
  }
  status = 200; malformed = true;
  assert.equal((await put(passwordBody("new-password"), true)).status, 502);
  malformed = false; brokenJson = true;
  assert.equal((await put(passwordBody("new-password"), true)).status, 502);
  brokenJson = false; network = true;
  assert.equal((await put(passwordBody("new-password"), true)).status, 502);
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.equal((await put(passwordBody("new-password"), true)).status, 503);
});
