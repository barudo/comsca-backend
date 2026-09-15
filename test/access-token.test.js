const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getUser } = require("../src/services/supabase-auth");

test("access tokens are verified with Supabase and provider failures fail closed", async (t) => {
  const names = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"];
  const old = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];
  }));
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
  let status = 200;
  let result = { id: "11111111-1111-4111-8111-111111111111" };
  let failure = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://example.supabase.co/auth/v1/user");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer access-token");
    assert.equal(options.headers.apikey, "test-key");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "error");
    if (failure) throw new Error("Private network detail");
    return { status, ok: status === 200, json: async () => result };
  });
  const input = { access_token: "access-token" };
  assert.deepEqual(await getUser(input), result);
  for (const [http, expected] of [[401, 401], [403, 401], [429, 429], [500, 502]]) {
    status = http;
    await assert.rejects(getUser(input), { status: expected });
  }
  status = 200;
  for (const malformed of [null, {}, { id: "invalid" }]) {
    result = malformed;
    await assert.rejects(getUser(input), { status: 502 });
  }
  failure = true;
  await assert.rejects(getUser(input), { status: 502, message: "Authentication service unavailable" });
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  await assert.rejects(getUser(input), { status: 503 });
});
