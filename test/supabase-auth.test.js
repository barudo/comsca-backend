const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signUp, verifyOtp } = require("../src/services/supabase-auth");

test("Supabase OTP verification checks the confirmed identity and handles provider errors", async (t) => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
  t.after(() => {
    for (const [key, value] of [["SUPABASE_URL", oldUrl], ["SUPABASE_PUBLISHABLE_KEY", oldKey]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const session = { user: { id: "11111111-1111-4111-8111-111111111111", phone: "639171234567",
    phone_confirmed_at: "2026-09-11T00:00:00Z" }, access_token: "test-access", refresh_token: "test-refresh" };
  let result = session;
  let status = 200;
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://example.supabase.co/auth/v1/verify");
    assert.equal(options.headers.apikey, "test-key");
    assert.deepEqual(JSON.parse(options.body), { phone: "+639171234567", token: "012345", type: "sms" });
    if (fail) throw new Error("Network failure");
    return { ok: status === 200, status, json: async () => result };
  });
  const input = { phone: "+639171234567", otp: "012345" };
  assert.deepEqual(await verifyOtp(input), session);
  for (const malformed of [{}, { ...session, user: { ...session.user, phone: "639181234567" } },
    { ...session, user: { ...session.user, phone_confirmed_at: null } }]) {
    result = malformed;
    await assert.rejects(verifyOtp(input), { status: 502 });
  }
  for (const [http, code, expected] of [[403, "otp_expired", 400], [429, "over_request_rate_limit", 429], [500, "unexpected_failure", 502]]) {
    status = http; result = { code, msg: "Private provider detail" };
    await assert.rejects(verifyOtp(input), { status: expected });
  }
  fail = true;
  await assert.rejects(verifyOtp(input), { status: 502, message: "Verification service unavailable" });
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  await assert.rejects(verifyOtp(input), { status: 503 });
});

test("Supabase signup uses phone/password and handles errors without exposing provider details", async (t) => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-public-key";
  t.after(() => {
    for (const [key, value] of [["SUPABASE_URL", oldUrl], ["SUPABASE_PUBLISHABLE_KEY", oldKey]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const input = { phone: "+639171234567", password: "test-password",
    metadata: { comsca_registration: { firstname: "Ana" } } };
  let response = { ok: true, json: async () => ({ id: "auth-user" }) };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://example.supabase.co/auth/v1/signup");
    assert.equal(options.headers.apikey, "test-public-key");
    assert.deepEqual(JSON.parse(options.body), { phone: input.phone, password: input.password,
      channel: "sms", data: input.metadata });
    return response;
  });
  assert.deepEqual(await signUp(input), { id: "auth-user" });
  response = { ok: true, json: async () => ({ user: { id: "auth-user" }, access_token: "unused" }) };
  assert.deepEqual(await signUp(input), { id: "auth-user" });
  for (const [status, code, expected] of [[429, "over_sms_send_rate_limit", 429],
    [422, "weak_password", 400], [500, "unexpected_failure", 502]]) {
    response = { ok: false, status, json: async () => ({ code, msg: "Sensitive internal detail" }) };
    await assert.rejects(signUp(input), { status: expected, message: "Registration could not be completed" });
  }
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  await assert.rejects(signUp(input), { status: 503 });
});
