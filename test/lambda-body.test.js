const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Webhook } = require("standardwebhooks");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function event(path, body, base64 = false, headers = {}) {
  return { version: "2.0", rawPath: path, rawQueryString: "",
    headers: { "content-type": "application/json", ...headers },
    requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
    body: base64 ? Buffer.from(body).toString("base64") : body, isBase64Encoded: base64 };
}

test("Lambda parses plain and base64 JSON registration bodies", async () => {
  let calls = 0;
  const handler = serverless(createApp(() => ({ where: (where) => {
    assert.deepEqual(where, { slug: "test-group" });
    calls++;
    return { first: async () => ({ id: 1 }) };
  } })));
  const payload = JSON.stringify({ firstname: "Ana", lastname: "Cruz", phone: "9171234567",
    groupName: "Test", slug: "test-group", password: "test-password" });
  for (const base64 of [false, true]) {
    const response = await handler(event("/api/v1/user/register", payload, base64), {});
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error, "Group slug is already in use");
  }
  assert.equal(calls, 2);
  const malformed = await handler(event("/api/v1/user/register", "{broken"), {});
  assert.equal(malformed.statusCode, 400);
  assert.equal(JSON.parse(malformed.body).error, "Invalid JSON body");
});

test("Lambda parses OTP verification bodies", async () => {
  let called = false;
  const handler = serverless(createApp(() => ({ where: () => ({ first: async () => undefined }) }), {
    verifyOtp: async (input) => {
      called = true;
      assert.deepEqual(input, { phone: "+639171234567", otp: "012345" });
      return { user: { id: "verified-id" } };
    },
  }));
  const response = await handler(event("/api/v1/user/verify", JSON.stringify({ phone: "9171234567", otp: "012345" })), {});
  assert.equal(called, true);
  assert.equal(response.statusCode, 409);
});

test("Lambda preserves the signed SMS body bytes", async (t) => {
  const old = process.env.SUPABASE_SMS_HOOK_SECRET;
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  process.env.SUPABASE_SMS_HOOK_SECRET = `v1,${secret}`;
  t.after(() => {
    if (old === undefined) delete process.env.SUPABASE_SMS_HOOK_SECRET;
    else process.env.SUPABASE_SMS_HOOK_SECRET = old;
  });
  let calls = 0;
  const handler = serverless(createApp(() => { throw new Error("No DB access expected"); }, {
    fetch: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).recipient, "+639171234567");
      return { ok: true };
    },
  }));
  const payload = JSON.stringify({ user: { phone: "639171234567" }, sms: { otp: "012345" } }, null, 2);
  const date = new Date();
  const headers = { "webhook-id": "sms-test", "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign("sms-test", date, payload) };
  for (const base64 of [false, true]) {
    const response = await handler(event("/api/v1/hooks/sms", payload, base64, headers), {});
    assert.equal(response.statusCode, 200);
  }
  assert.equal(calls, 2);
  const tampered = await handler(event("/api/v1/hooks/sms", `${payload} `, false, headers), {});
  assert.equal(tampered.statusCode, 401);
  assert.equal(calls, 2);
});
