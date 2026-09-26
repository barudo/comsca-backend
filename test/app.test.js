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
        first: async () => (slug === "comsca" ? { id: 1, name: "COMSCA", slug } : undefined),
      }),
    };
  });
}

test("slug availability is public and normalizes the query slug", async () => {
  for (const prefix of ["/api/v1/groups"]) {
    const taken = await request(createTestApp(), `${prefix}/validate-slug?slug=%20COMSCA%20`);
    assert.equal(taken.status, 200);
    assert.deepEqual(taken.body, {
      success: false,
      message: "Group slug is already in use",
      group: { id: 1, name: "COMSCA" },
    });
    const available = await request(createTestApp(), `${prefix}/validate-slug?slug=new-group`);
    assert.equal(available.status, 200);
    assert.deepEqual(available.body, { success: true, message: "Group slug is available" });
  }
});

test("slug validation rejects invalid queries before querying the database", async () => {
  let calls = 0;
  const app = createApp(() => { calls++; throw new Error("Unexpected query"); });
  for (const query of ["", "?slug=", "?slug=%20", "?slug=a&slug=b", "?slug=-bad",
    "?slug=bad-", "?slug=bad_slug", "?slug=ADMIN", `?slug=${"a".repeat(64)}`]) {
    const result = await request(app, `/api/v1/groups/validate-slug${query}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.equal(typeof result.body.message, "string");
  }
  assert.equal(calls, 0);
});

test("slug validation does not report availability when the database fails", async () => {
  const app = createApp(() => ({ where: () => ({ first: async () => {
    throw new Error("Private database details");
  } }) }));
  const result = await request(app, "/api/v1/groups/validate-slug?slug=new-group");
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { success: false, message: "Slug validation service unavailable" });
});

test("POST /api/v1/auth/login reaches the legacy auth handler", async () => {
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
