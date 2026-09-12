const { test } = require("node:test");
const assert = require("node:assert/strict");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

test("Supabase login endpoints exchange credentials and resolve only the authenticated profile", async (t) => {
  const old = [process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
  t.after(() => {
    for (const [i, name] of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"].entries()) {
      if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];
    }
  });
  t.mock.method(console, "error", () => {});
  const session = { user: { id: "11111111-1111-4111-8111-111111111111",
    phone: "639171234567", phone_confirmed_at: "2026-09-12T00:00:00Z" },
    access_token: "new-access", refresh_token: "new-refresh", token_type: "bearer", expires_in: 3600 };
  let status = 200;
  let result = session;
  let networkFailure = false;
  let invalidJson = false;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.apikey, "test-key");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    if (networkFailure) throw new TypeError("Private network detail");
    return { status, ok: status >= 200 && status < 300, json: async () => {
      assert.notEqual(status, 204, "Logout must not parse an empty response");
      if (invalidJson) throw new SyntaxError("Private upstream body");
      return result;
    } };
  });
  let missingProfile = false;
  let missingGroup = false;
  let databaseCalls = 0;
  const user = { id: 1, auth_user_id: session.user.id, group_id: 2, first_name: "Ana" };
  const group = { id: 2, name: "Community", slug: "community" };
  const handler = serverless(createApp((table) => {
    databaseCalls++;
    return { where: (where) => ({ first: async (...columns) => {
      assert.equal(columns.includes("password"), false);
      if (table === "users") {
        assert.deepEqual(where, { auth_user_id: session.user.id });
        return missingProfile ? undefined : user;
      }
      assert.equal(table, "groups");
      assert.deepEqual(where, { id: 2 });
      return missingGroup ? undefined : group;
    } }) };
  }));
  const post = async (path, body, headers = {}) => {
    const response = await handler({ version: "2.0", rawPath: `/api/v1/auth/${path}`, rawQueryString: "",
      headers: { "content-type": "application/json", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
      body: JSON.stringify(body), isBase64Encoded: false }, {});
    assert.equal(response.headers["cache-control"], "no-store");
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const credentials = { phone: "09171234567", password: "test-password" };
  for (const [path, body, expectedPath, payload] of [
    ["login/password", credentials, "token?grant_type=password", { phone: "+639171234567", password: "test-password" }],
    ["login/otp/verify", { phone: "9171234567", otp: "012345" }, "verify",
      { phone: "+639171234567", token: "012345", type: "sms" }],
    ["refresh", { refresh_token: "old-refresh" }, "token?grant_type=refresh_token", { refresh_token: "old-refresh" }],
  ]) {
    const response = await post(path, { ...body, auth_user_id: "attacker", slug: "wrong-group" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, user, group, session: {
      access_token: "new-access", refresh_token: "new-refresh", token_type: "bearer", expires_in: 3600,
    } });
    assert.equal(calls.at(-1).url, `https://example.supabase.co/auth/v1/${expectedPath}`);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), payload);
  }
  result = {};
  const before = databaseCalls;
  const sent = await post("login/otp/request", { phone: "639171234567" });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.success, true);
  assert.equal(calls.at(-1).url, "https://example.supabase.co/auth/v1/otp");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { phone: "+639171234567", channel: "sms", create_user: false });
  status = 204;
  assert.deepEqual(await post("logout", {}, { authorization: "Bearer current-access" }), {
    status: 200, body: { success: true, message: "Logged out successfully" },
  });
  assert.equal(calls.at(-1).url, "https://example.supabase.co/auth/v1/logout?scope=local");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer current-access");
  assert.equal(databaseCalls, before);

  for (const [path, body, expected] of [
    ["login/password", {}, 400], ["login/password", { ...credentials, password: 123 }, 400],
    ["login/otp/request", { phone: "invalid" }, 400],
    ["login/otp/verify", { phone: credentials.phone, otp: 123456 }, 400],
    ["refresh", { refresh_token: " " }, 400], ["logout", { access_token: "body-token" }, 401],
  ]) {
    const count = calls.length;
    assert.equal((await post(path, body)).status, expected);
    assert.equal(calls.length, count);
  }
  for (const [path, body, http, code, expected, message] of [
    ["login/password", credentials, 400, "invalid_credentials", 401, "Invalid phone number or password"],
    ["login/password", credentials, 400, "phone_not_confirmed", 403, "Verify your phone number before signing in"],
    ["login/otp/verify", { phone: credentials.phone, otp: "012345" }, 403, "otp_expired", 400, "Invalid or expired verification code"],
    ["refresh", { refresh_token: "old" }, 400, "refresh_token_already_used", 401, "Invalid or expired session; sign in again"],
    ["logout", {}, 401, "bad_jwt", 401, "Invalid or expired session; sign in again"],
    ["login/otp/request", credentials, 429, "over_sms_send_rate_limit", 429, "Too many authentication attempts; try again later"],
    ["login/password", credentials, 500, "unexpected_failure", 502, "Authentication service unavailable"],
  ]) {
    status = http; result = { error_code: code, msg: "Private provider detail" };
    assert.deepEqual(await post(path, body, { authorization: "Bearer bad-token" }), {
      status: expected, body: { success: false, error: message },
    });
  }
  status = 400; result = { error_code: "signup_disabled" };
  assert.deepEqual(await post("login/otp/request", credentials), sent);
  status = 200;
  for (const malformed of [null, {}, { ...session, refresh_token: "" },
    { ...session, user: { ...session.user, phone: "639181234567" } },
    { ...session, user: { ...session.user, phone_confirmed_at: null } }]) {
    result = malformed;
    assert.equal((await post("login/password", credentials)).status, 502);
  }
  invalidJson = true;
  assert.equal((await post("refresh", { refresh_token: "old" })).status, 502);
  invalidJson = false; networkFailure = true;
  assert.equal((await post("login/password", credentials)).status, 502);
  networkFailure = false; result = session; missingProfile = true;
  assert.equal((await post("login/password", credentials)).status, 409);
  missingProfile = false; missingGroup = true;
  assert.equal((await post("refresh", { refresh_token: "old" })).status, 409);
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.equal((await post("login/password", credentials)).status, 503);
});
