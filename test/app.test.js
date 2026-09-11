const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

function request(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}`, options)
        .then(async (response) => {
          resolve({ status: response.status, body: await response.json() });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

function createTestApp() {
  return createApp((table) => {
    assert.equal(table, "groups");
    return {
      where: ({ slug }) => ({
        first: async () => (slug === "comsca" ? { id: 1, slug } : undefined),
      }),
    };
  });
}

test("GET / rejects requests without a group slug", async () => {
  const result = await request(createTestApp(), "/");

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    success: false,
    error: "x-group-slug header is required",
  });
});

test("GET / rejects unknown group slugs", async () => {
  const result = await request(createTestApp(), "/", {
    headers: { "x-group-slug": "unknown" },
  });

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, {
    success: false,
    error: "Group not found",
  });
});

test("GET / returns the welcome response for a known group slug", async () => {
  const result = await request(createTestApp(), "/", {
    headers: { "x-group-slug": "comsca" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    message: "On this site will rise the awesome",
  });
});

test("POST /api/v1/auth/login is loaded from the auth route file", async () => {
  const result = await request(createTestApp(), "/api/v1/auth/login", {
    method: "POST",
    headers: { "x-group-slug": "comsca" },
  });

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    success: false,
    error: "A username and password (maximum 72 bytes) are required",
  });
});

test("database connection failures return a service-unavailable response", async () => {
  const app = createApp(() => {
    const error = new Error("connect ECONNREFUSED");
    error.code = "ECONNREFUSED";
    return {
      where: () => ({
        first: () => Promise.reject(error),
      }),
    };
  });

  const result = await request(app, "/api/v1/login", {
    method: "POST",
    headers: { "x-group-slug": "comsca" },
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    success: false,
    error: "Database unavailable",
  });
});
