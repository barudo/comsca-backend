const test = require("node:test");
const assert = require("node:assert/strict");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

async function request(handler, path, method = "GET", headers = {}, body) {
  const result = await handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers,
    requestContext: { http: { method, path, sourceIp: "127.0.0.1" } },
    ...(body === undefined ? {} : { body: JSON.stringify(body), isBase64Encoded: false }),
  }, {});
  return { status: result.statusCode, body: result.body, headers: result.headers };
}

test("legacy auth remains group-scoped while Supabase authentication is public", async () => {
  let lookups = 0;
  const handler = serverless(createApp(() => {
    lookups++;
    return { where: () => ({ first: async () => ({ id: 1, slug: "group" }) }) };
  }));
  for (const [method, path] of [["GET", "/api/v1/auth"], ["POST", "/api/v1/auth/login"]]) {
    const result = await request(handler, path, method);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error, "x-group-slug header is required");
  }
  for (const path of ["/login/password", "/login/otp/request", "/login/otp/verify", "/refresh", "/logout"]) {
    for (const headers of [{}, { "x-group-slug": "nonexistent" }, { "x-group-slug": "!invalid!" }]) {
      const result = await request(handler, `/api/v1/auth${path}`, "POST", headers);
      assert.equal(result.status, path === "/logout" ? 401 : 400);
      assert.notEqual(JSON.parse(result.body).error, "x-group-slug header is required");
    }
  }
  assert.equal(lookups, 0);
  const result = await request(handler, "/api/v1/auth/", "GET", { "x-group-slug": "group" });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { success: true, message: "Authentication endpoint" });
  assert.equal(lookups, 1);
});

test("unknown routes retain the group gate and then fall through to 404", async () => {
  const handler = serverless(createApp(() => ({
    where: () => ({ first: async () => ({ id: 1, slug: "group" }) }),
  })));
  for (const path of ["/api/v1/missing", "/api/v1/auth/missing", "/api/v1/hooks/missing", "/api/v1/user/missing"]) {
    const missingGroup = await request(handler, path);
    assert.equal(missingGroup.status, 400);
    assert.equal(JSON.parse(missingGroup.body).error, "x-group-slug header is required");
    assert.equal((await request(handler, path, "GET", { "x-group-slug": "group" })).status, 404);
  }
});

test("OPTIONS without Origin remains public for public endpoints and group-scoped elsewhere", async () => {
  let lookups = 0;
  const handler = serverless(createApp(() => {
    lookups++;
    return { where: () => ({ first: async () => ({ id: 1, slug: "group" }) }) };
  }));
  for (const [path, methods] of [
    ["/api/v1/hooks/sms", "POST"], ["/api/v1/user/register", "POST"],
    ["/api/v1/user/verify", "POST"], ["/groups/validate-slug", "GET, HEAD"],
    ["/api/v1/groups/validate-slug", "GET, HEAD"],
    ...["/login/password", "/login/otp/request", "/login/otp/verify", "/refresh", "/logout"]
      .map(path => [`/api/v1/auth${path}`, "POST"]),
  ]) {
    const result = await request(handler, path, "OPTIONS");
    assert.equal(result.status, 200, path);
    assert.equal(result.headers.allow, methods, path);
  }
  assert.equal(lookups, 0);
  assert.equal((await request(handler, "/api/v1/cycles", "OPTIONS")).status, 400);
  const result = await request(handler, "/api/v1/cycles", "OPTIONS", { "x-group-slug": "group" });
  assert.equal(result.status, 200);
  assert.equal(result.headers.allow, "GET, HEAD, POST");
  assert.equal(lookups, 1);
});

test("handler instances use each application's injected services without leaking state", { timeout: 2000 }, async () => {
  const calls = [[], []];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let pending = 0;
  const apps = calls.map(log => serverless(createApp(() => {
    throw new Error("Public OTP requests must not query groups");
  }, { requestOtp: async input => {
    if (++pending === 3) release();
    await barrier;
    log.push(input);
  } })));
  const send = (handler, phone) => request(handler, "/api/v1/auth/login/otp/request", "POST",
    { "content-type": "application/json" }, { phone });
  const responses = await Promise.all([
    send(apps[0], "09171234567"), send(apps[1], "09181234567"), send(apps[0], "09191234567"),
  ]);
  assert.deepEqual(responses.map(result => result.status), [200, 200, 200]);
  assert.deepEqual(calls, [
    [{ phone: "+639171234567" }, { phone: "+639191234567" }],
    [{ phone: "+639181234567" }],
  ]);
});

test("HEAD preserves GET headers and omits the response body", async () => {
  const handler = serverless(createApp(() => ({
    where: () => ({ first: async () => ({ id: 1, name: "Group", slug: "group" }) }),
  })));
  for (const [path, headers] of [
    ["/groups/validate-slug", {}],
    ["/api/v1/auth", { "x-group-slug": "group" }],
    ["/", { "x-group-slug": "group" }],
  ]) {
    const get = await request(handler, path, "GET", headers);
    const head = await request(handler, path, "HEAD", headers);
    assert.equal(head.status, get.status);
    assert.equal(head.body, "");
    for (const header of ["content-type", "content-length", "cache-control"]) {
      assert.equal(head.headers[header], get.headers[header]);
    }
  }
});

test("group resolution and protected handlers use the same application's database", async () => {
  const apps = [1, 2].map(id => serverless(createApp(table => ({
    where: where => ({ first: async () => {
      if (table === "groups") {
        assert.deepEqual(where, { slug: `group-${id}` });
        return { id, name: `Group ${id}`, slug: `group-${id}` };
      }
      assert.equal(table, "users");
      assert.deepEqual(where, { auth_user_id: `auth-${id}`, group_id: id });
      return { id: id * 10, group_id: id };
    } }),
  }), { getUser: async () => ({ id: `auth-${id}` }) })));
  const results = await Promise.all(apps.map((app, index) => request(app, "/api/v1/users/me", "GET", {
    "x-group-slug": `group-${index + 1}`, authorization: "Bearer test-token",
  })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.group.id, index + 1);
    assert.equal(body.user.group_id, index + 1);
  }
});
