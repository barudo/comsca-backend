const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Webhook } = require("standardwebhooks");
const { createApp } = require("../src/app");

async function serve(t, app) {
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const input = { firstname: " Ana ", lastname: " Cruz ", phone: "09171234567",
  groupName: " Community ", slug: " Community ", password: "test-password" };

test("verification uses the OTP identity, validates input, and returns only its linked profile", async (t) => {
  let calls = 0;
  let error;
  let missing = false;
  const base = await serve(t, createApp((table) => ({ where: (where) => ({ first: async () => {
    if (table === "users") {
      assert.deepEqual(where, { auth_user_id: "verified-id" });
      return missing ? undefined : { id: 1, group_id: 2, first_name: "Ana" };
    }
    assert.deepEqual(where, { id: 2 });
    return { id: 2, slug: "actual-group" };
  } }) }), { verifyOtp: async (args) => {
    calls++;
    assert.deepEqual(args, { phone: "+639171234567", otp: "012345" });
    if (error) throw error;
    return { user: { id: "verified-id" }, access_token: "test-access", refresh_token: "test-refresh",
      token_type: "bearer", expires_in: 3600 };
  } }));
  const post = (body) => fetch(`${base}/api/v1/user/verify`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [{}, { phone: "bad", otp: "012345" }, { phone: input.phone, otp: 12345 }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls, 0);
  const body = { phone: "9171234567", otp: "012345", auth_user_id: "attacker-id", slug: "wrong-group" };
  const response = await post(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.group.slug, "actual-group");
  assert.equal(result.session.access_token, "test-access");
  assert.equal(result.session.refresh_token, "test-refresh");
  error = Object.assign(new Error("Invalid or expired verification code"), { status: 400 });
  const denied = await post(body);
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).session, undefined);
  error = undefined;
  missing = true;
  const unlinked = await post(body);
  assert.equal(unlinked.status, 409);
  assert.equal((await unlinked.json()).session, undefined);
});

test("registration validates input and maps metadata without storing passwords", async (t) => {
  let signup;
  let conflict = false;
  const app = createApp((table) => ({ where: (where) => ({ first: async () => {
    if (table === "groups") return where.id ? { id: 1 } : conflict ? { id: 1 } : undefined;
    assert.equal(table, "users");
    assert.equal(where.auth_user_id, "11111111-1111-4111-8111-111111111111");
    return { id: 1, group_id: 1 };
  } }) }), { signUp: async (args) => {
    signup = args; return { id: "11111111-1111-4111-8111-111111111111" };
  } });
  const base = await serve(t, app);
  const post = (body) => fetch(`${base}/api/v1/user/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [{}, { ...input, phone: "bad" }, { ...input, slug: "www" },
    { ...input, firstname: {} }, { ...input, password: "short" }, { ...input, slug: "a.b" }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(signup, undefined);
  const response = await post({ ...input, phone: "9171234567" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).verification_required, true);
  assert.deepEqual(signup, { phone: "+639171234567", password: "test-password",
    metadata: { comsca_registration: { firstname: "Ana", lastname: "Cruz", groupName: "Community", slug: "community" } } });
  conflict = true;
  signup = undefined;
  assert.equal((await post(input)).status, 409);
  assert.equal(signup, undefined);
});

test("registration handles Auth failure and never links an existing identity", async (t) => {
  let fail = true;
  const app = createApp(() => ({ where: () => ({ first: async () => undefined }) }), {
    signUp: async () => {
      if (fail) throw Object.assign(new Error("Registration could not be completed"), { status: 502 });
      return { id: "11111111-1111-4111-8111-111111111111" };
    },
  });
  const base = await serve(t, app);
  const post = () => fetch(`${base}/api/v1/user/register`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal((await post()).status, 502);
  fail = false;
  assert.equal((await post()).status, 409);
});

test("SMS hook verifies signatures, maps OTPs, and reports gateway failures", async (t) => {
  const previous = process.env.SUPABASE_SMS_HOOK_SECRET;
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  process.env.SUPABASE_SMS_HOOK_SECRET = `v1,${secret}`;
  t.after(() => {
    if (previous === undefined) delete process.env.SUPABASE_SMS_HOOK_SECRET;
    else process.env.SUPABASE_SMS_HOOK_SECRET = previous;
  });
  let calls = 0;
  let gatewayOk = true;
  const base = await serve(t, createApp(() => { throw new Error("Hook must not query groups"); }, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.brevph.com/api/v1/cane/send");
      assert.deepEqual(JSON.parse(options.body), { recipient: "+639171234567",
        message: "Your COMSCA verification code is 123456. Do not share this code." });
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      return { ok: gatewayOk };
    },
  }));
  const payload = JSON.stringify({ user: { phone: "639171234567" }, sms: { otp: "123456" } });
  function headers(body = payload, date = new Date()) {
    return { "content-type": "application/json", "webhook-id": "test-message",
      "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign("test-message", date, body) };
  }
  const post = (body = payload, h = headers()) => fetch(`${base}/api/v1/hooks/sms`, { method: "POST", headers: h, body });
  assert.equal((await post(payload, { "content-type": "application/json" })).status, 401);
  assert.equal((await post(`${payload} `)).status, 401);
  assert.equal((await post(payload, headers(payload, new Date(Date.now() - 600000)))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await post()).status, 200);
  assert.equal(calls, 1);
  const malformed = JSON.stringify({ user: { phone: "bad" }, sms: { otp: "123456" } });
  assert.equal((await post(malformed, headers(malformed))).status, 400);
  gatewayOk = false;
  const response = await post();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.http_code, 502);
  delete process.env.SUPABASE_SMS_HOOK_SECRET;
  assert.equal((await post()).status, 503);
});
