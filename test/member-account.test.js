const { test } = require("node:test");
const assert = require("node:assert/strict");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");
const { createMemberAccount } = require("../src/services/member-account");

function fixture() {
  const actorId = "11111111-1111-4111-8111-111111111111";
  const accountId = "22222222-2222-4222-8222-222222222222";
  const state = { role: "OWNER", target: { id: "20", group_id: "1", phone: "+639171234567", auth_user_id: null, role: "MEMBER" },
    migration: true, missing: false, link: true, calls: [], providerError: null };
  const handler = serverless(createApp(table => ({ where: where => ({ first: async (...columns) => {
    if (table === "groups") return where.slug === "alpha" ? { id: "1" } : where.slug === "beta" ? { id: "2" } : undefined;
    if (table === "knex_migrations") {
      assert.equal(where.name, "009_link_member_auth_accounts.js");
      return state.migration ? { id: 9 } : undefined;
    }
    assert.equal(table, "users");
    if (where.auth_user_id === actorId) return where.group_id === "1" ? { id: "10", role: state.role } : undefined;
    assert.deepEqual({ id: where.id, group_id: where.group_id }, { id: "20", group_id: "1" });
    if (state.missing || (where.auth_user_id && state.target.auth_user_id !== where.auth_user_id)) return undefined;
    return Object.fromEntries(columns.map(column => [column, state.target[column]]));
  } }) }), {
    getUser: async () => ({ id: actorId }),
    createMemberAccount: async input => {
      state.calls.push(input);
      if (state.providerError) throw state.providerError;
      if (state.link) state.target.auth_user_id = accountId;
      return { id: accountId };
    },
  }));
  const post = async (body = { password: "initial-password" }, path = "/api/v1/groups/users/20/account", headers = {}) => {
    const response = await handler({ version: "2.0", rawPath: path, rawQueryString: "",
      headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
      body: JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers };
  };
  return { state, post };
}

test("owner/admin can provision a group member once, using saved identity and server metadata", async () => {
  for (const role of ["OWNER", "ADMIN"]) {
    for (const path of ["/api/v1/groups/users/20/account"]) {
      const { state, post } = fixture();
      state.role = role;
      const result = await post(undefined, path);
      assert.equal(result.status, 201);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, user: { id: "20", group_id: "1", phone: "+639171234567", role: "MEMBER", has_login: true, phone_verified: true } });
      assert.deepEqual(state.calls, [{ phone: "+639171234567", password: "initial-password", user_id: "20", group_id: "1", actor_id: "10" }]);
      assert.equal((await post(undefined, path)).status, 409);
      assert.equal(state.calls.length, 1);
    }
  }
});

test("account provisioning rejects unauthorized callers and invalid targets before contacting Auth", async () => {
  const { state, post } = fixture();
  assert.equal((await post(undefined, undefined, { authorization: "" })).status, 401);
  assert.equal((await post(undefined, undefined, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(undefined, undefined, { "x-group-slug": "missing" })).status, 404);
  assert.equal((await post(undefined, undefined, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR"]) {
    state.role = role;
    assert.equal((await post()).status, 403);
  }
  state.role = "OWNER";
  for (const id of ["0", "-1", "abc", "1.2", "9223372036854775808"]) {
    assert.equal((await post(undefined, `/api/v1/groups/users/${id}/account`)).status, 400);
  }
  for (const body of [null, [], {}, { password: 123 }, { password: "short" }, { password: "é".repeat(37) },
    { password: "initial-password", phone: "+639181234567" }, { password: "initial-password", role: "OWNER" }]) {
    assert.equal((await post(body)).status, 400);
  }
  state.missing = true;
  assert.equal((await post()).status, 404);
  state.missing = false;
  state.target.phone = null;
  assert.equal((await post()).status, 400);
  state.target.phone = "+639171234567";
  state.migration = false;
  assert.equal((await post()).status, 503);
  assert.equal(state.calls.length, 0);
});

test("account provisioning propagates safe errors and verifies the database link", async () => {
  const { state, post } = fixture();
  for (const status of [400, 409, 429, 502, 503]) {
    state.providerError = Object.assign(new Error("Safe provisioning error"), { status });
    assert.equal((await post()).status, status);
  }
  state.providerError = null;
  state.link = false;
  assert.equal((await post()).status, 502);
});

test("Supabase admin provisioning confirms the phone without public signup or user metadata", async t => {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const old = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];
  }));
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";
  const account = { id: "22222222-2222-4222-8222-222222222222", phone: "639171234567", phone_confirmed_at: "2026-09-17T00:00:00Z" };
  let status = 200;
  let result = account;
  let failure = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://example.supabase.co/auth/v1/admin/users");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer server-only-test-key");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { phone: "+639171234567", password: "initial-password", phone_confirm: true,
      app_metadata: { comsca_member: { user_id: "20", group_id: "1", actor_id: "10" } } });
    if (failure) throw new Error("Private network error");
    return { ok: status === 200, status, json: async () => result };
  });
  const input = { phone: "+639171234567", password: "initial-password", user_id: 20, group_id: 1, actor_id: 10 };
  assert.deepEqual(await createMemberAccount(input), account);
  for (const [http, code, expected] of [[422, "phone_exists", 409], [422, "weak_password", 400], [429, "rate_limit", 429], [500, "unexpected_failure", 502]]) {
    status = http; result = { code, message: "Private provider detail" };
    await assert.rejects(createMemberAccount(input), { status: expected });
  }
  status = 200;
  for (const invalid of [null, {}, { ...account, phone_confirmed_at: null }, { ...account, phone: "639181234567" }]) {
    result = invalid;
    await assert.rejects(createMemberAccount(input), { status: 502 });
  }
  failure = true;
  await assert.rejects(createMemberAccount(input), { status: 502 });
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(createMemberAccount(input), { status: 503 });
});
