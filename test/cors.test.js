const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

test("CORS preflights bypass group lookup and API errors retain CORS headers", async (t) => {
  const app = createApp(() => { throw new Error("No database access expected"); });
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/user/verify`;
  for (const origin of ["https://comsca.com", "https://group.comsca.com", "http://localhost:3000", "http://group.localhost:3001"]) {
    const response = await fetch(url, { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization,x-group-slug",
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("access-control-allow-headers"), /Authorization/);
    assert.match(response.headers.get("vary"), /Origin/);
  }
  for (const origin of ["https://evil.com", "https://comsca.com.evil.com", "null"]) {
    const response = await fetch(url, { method: "OPTIONS", headers: { Origin: origin } });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const response = await fetch(url, { method: "POST", headers: {
    Origin: "https://comsca.com", "Content-Type": "application/json",
  }, body: "{}" });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://comsca.com");
});
