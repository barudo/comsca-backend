const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", group: 1, inserts: [], insertError: null, authError: null };
  const authId = "11111111-1111-4111-8111-111111111111";
  Object.defineProperty(db, "transaction", { value: async callback => callback(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    if (query.sql.includes('from "groups"')) {
      return query.bindings[0] === "alpha" ? { id: 1, slug: "alpha" } :
        query.bindings[0] === "beta" ? { id: 2, slug: "beta" } : undefined;
    }
    if (query.sql.includes('from "users"')) {
      assert.match(query.sql, /for update$/);
      assert.deepEqual(query.bindings, [authId, query.bindings[1], 1]);
      return query.bindings[1] === state.group ? { id: 10, role: state.role } : undefined;
    }
    assert.match(query.sql, /^insert into "cycles"/);
    if (state.insertError) throw state.insertError;
    const values = builder._single.insert;
    state.inserts.push(values);
    assert.deepEqual(query.returning, ["id", "group_id", "interest_rate", "interest_period", "interest_method",
      "cost_per_share", "status", "created_at", "updated_at"]);
    return [{ id: 20, ...values, created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" }];
  } });
  const handler = serverless(createApp(db, { getUser: async () => {
    if (state.authError) throw state.authError;
    return { id: authId, user_metadata: { role: "OWNER", group_id: 2 } };
  } }));
  const post = async (body = {}, options = {}) => {
    const response = await handler({ version: "2.0", rawPath: options.path || "/cycles",
      rawQueryString: "group_id=2", headers: { "content-type": "application/json",
        authorization: "Bearer verified-token", "x-group-slug": "alpha", ...options.headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } },
      body: options.rawBody ?? JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers };
  };
  return { state, post };
}

const terms = { interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "COMPOUND", cost_per_share: "100.00" };

test("cycle creation permits group OWNER/ADMIN on both paths and returns saved fields", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const path of ["/cycles", "/api/v1/cycles"]) {
      const result = await post({ ...terms, status: "active" }, { path });
      assert.equal(result.status, 201);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, cycle: { id: 20, ...terms, status: "active", group_id: 1,
        created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" } });
    }
  }
  state.group = 2;
  assert.equal((await post({}, { headers: { "x-group-slug": "beta" } })).body.cycle.group_id, 2);
});

test("cycles support nullable financial settings, allowed enums, statuses and exact decimal limits", async t => {
  const { post } = fixture(t);
  assert.deepEqual((await post()).body.cycle, { id: 20, group_id: 1, interest_rate: null,
    interest_period: null, interest_method: null, cost_per_share: null, status: "inactive",
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" });
  assert.equal((await post({ interest_rate: null, interest_period: null, interest_method: null, cost_per_share: null })).status, 201);
  for (const interest_period of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]) {
    for (const interest_method of ["SIMPLE", "COMPOUND"]) {
      assert.equal((await post({ ...terms, interest_rate: 0, interest_period, interest_method })).status, 201);
    }
  }
  for (const status of ["active", "inactive", "distributing"]) assert.equal((await post({ status })).status, 201);
  for (const interest_rate of ["999.999999", "0.000001", 2.5]) {
    assert.equal((await post({ ...terms, interest_rate })).status, 201);
  }
  for (const cost_per_share of ["9999999999999999.99", "0.01", 100]) {
    const result = await post({ cost_per_share });
    assert.equal(result.status, 201);
    assert.equal(result.body.cycle.cost_per_share, String(cost_per_share));
  }
});

test("cycles reject unauthenticated, cross-group and non-manager requests without inserts", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post({}, { headers: { authorization: "" } })).status, 401);
  assert.equal((await post({}, { headers: { "x-group-slug": "" } })).status, 400);
  assert.equal((await post({}, { headers: { "x-group-slug": "unknown" } })).status, 404);
  for (const path of ["/cycles", "/api/v1/cycles"]) {
    assert.equal((await post({}, { path, headers: { "x-group-slug": "beta" } })).status, 403);
    for (const role of ["MEMBER", "TREASURER", "AUDITOR", "admin", null]) {
      state.role = role;
      assert.equal((await post({}, { path })).status, 403);
    }
  }
  state.authError = Object.assign(new Error("Invalid token"), { status: 401 });
  assert.equal((await post()).status, 401);
  assert.equal(state.inserts.length, 0);
});

test("cycle input enforces database constraints and rejects protected or unknown fields", async t => {
  const { state, post } = fixture(t);
  for (const body of [null, [], "cycle", { group_id: 2 }, { id: 20 }, { created_at: "2026-09-20" },
    { updated_at: "2026-09-20" }, { name: "Cycle" }, { status: null }, { status: "ACTIVE" },
    { status: "ended" }, { status: [] }, { interest_rate: 2 }, { interest_period: "MONTHLY" },
    { interest_method: "SIMPLE" }, { ...terms, interest_method: null }, { ...terms, interest_rate: null },
    { ...terms, interest_period: null }, { ...terms, interest_period: "monthly" },
    { ...terms, interest_method: "FLAT" }, { ...terms, interest_rate: -1 },
    { ...terms, interest_rate: "1000" }, { ...terms, interest_rate: "0.0000001" },
    { ...terms, interest_rate: true }, { ...terms, interest_rate: "NaN" },
    { ...terms, interest_rate: "Infinity" }, { ...terms, interest_rate: "1e2" },
    { ...terms, interest_rate: "" }, { cost_per_share: 0 }, { cost_per_share: -1 },
    { cost_per_share: "0.001" }, { cost_per_share: "10000000000000000" },
    { cost_per_share: {} }, { cost_per_share: "NaN" }, { cost_per_share: "Infinity" }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({}, { rawBody: "{" })).status, 400);
  assert.equal((await post({}, { rawBody: '{"cost_per_share":9007199254740993}' })).status, 400);
  assert.equal(state.inserts.length, 0);
});

test("cycle creation reports active-cycle conflicts without exposing internal failures", async t => {
  const { state, post } = fixture(t);
  state.insertError = Object.assign(new Error("Private constraint details"), { code: "23505", constraint: "cycles_one_active_per_group" });
  const conflict = await post({ status: "active" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { success: false, error: "This group already has an active cycle" });
  for (const error of [new Error("Private database details"), Object.assign(new Error("Other unique constraint"), { code: "23505", constraint: "cycles_pkey" })]) {
    state.insertError = error;
    const result = await post();
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: "Internal server error" });
  }
});
