const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", actor: true, cycle: true, member: true, membership: true, writes: [] };
  Object.defineProperty(db, "transaction", { value: fn => fn(db) });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL();
    const table = builder._single.table;
    if (table === "groups") return { id: "1" };
    if (table === "users") {
      assert.equal(q.bindings[1], "1");
      if (q.sql.includes('"auth_user_id"')) return state.actor ? { id: "10", role: state.role } : undefined;
      return state.member ? { id: q.bindings[0] } : undefined;
    }
    if (table === "cycles") {
      assert.deepEqual(q.bindings, ["1", "draft", "active", "distributing", 1]);
      return state.cycle ? { id: "20" } : undefined;
    }
    if (table === "cycle_members") {
      assert.equal(q.bindings[1], "20");
      return state.membership ? { user_id: q.bindings[0] } : undefined;
    }
    assert.equal(table, "loan_applications");
    if (q.method === "first") {
      assert.deepEqual(q.bindings, ["1", "10", "active", 1]);
      assert.match(q.sql, /order by "created_at" desc, "id" desc limit \?/);
      assert.doesNotMatch(q.sql, /"cycle_id" =/);
      if (state.readError) throw state.readError;
      return state.latest;
    }
    assert.equal(q.method, "insert");
    state.writes.push(builder._single.insert);
    return [{ id: "100", ...builder._single.insert }];
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user" }) }));
  async function post(path, body, authorization = "Bearer token", method = "POST") {
    const result = await handler({
      version: "2.0", rawPath: `/api/v1/${path}`, rawQueryString: "",
      headers: { "content-type": "application/json", "x-group-slug": "alpha", authorization },
      requestContext: { http: { method, sourceIp: "127.0.0.1" } },
      body: JSON.stringify(body), isBase64Encoded: false,
    }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }
  const get = (authorization) => post("me/loans/apply", undefined, authorization, "GET");
  return { state, post, get };
}

test("managed loan applications allow financial writers and persist the selected applicant", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post("loans/apply", { user_id: "11", amount_desired: 2000 });
    assert.equal(result.status, 201);
    assert.deepEqual(state.writes.at(-1), { group_id: "1", user_id: "11", cycle_id: "20", amount_desired: "2000.00" });
    assert.equal(result.body.loan_application.user_id, "11");
  }
  for (const role of ["MEMBER", "AUDITOR"]) {
    state.role = role;
    assert.equal((await post("loans/apply", { user_id: "11", amount_desired: 2000 })).status, 403);
  }
  assert.equal(state.writes.length, 3);
});

test("self applications use authenticated identity for every group role and reject overrides", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER", "MEMBER", "AUDITOR"]) {
    state.role = role;
    const result = await post("me/loans/apply", { amount_desired: "0.01" });
    assert.equal(result.status, 201);
    assert.equal(result.body.loan_application.user_id, "10");
    assert.equal((await post("me/loans/apply", { user_id: "11", amount_desired: 1 })).status, 400);
  }
  assert.equal(state.writes.length, 5);
});

test("new application routes enforce authentication, group membership and input validation", async t => {
  const { state, post } = fixture(t);
  for (const path of ["loans/apply", "me/loans/apply"]) {
    const body = path === "loans/apply" ? { user_id: "11", amount_desired: 1 } : { amount_desired: 1 };
    assert.equal((await post(path, body, "")).status, 401);
    state.actor = false;
    assert.equal((await post(path, body)).status, 403);
    state.actor = true;
    for (const amount_desired of [0, -1, "1.001", null]) {
      assert.equal((await post(path, { ...body, amount_desired })).status, 400);
    }
    state.cycle = false;
    assert.equal((await post(path, body)).status, 409);
    state.cycle = true;
    state.member = false;
    assert.equal((await post(path, body)).status, 404);
    state.member = true;
    state.membership = false;
    assert.equal((await post(path, body)).status, 400);
    state.membership = true;
  }
  assert.equal((await post("loans/apply", { amount_desired: 1 })).status, 400);
  assert.equal(state.writes.length, 0);
});

test("legacy application route retains role-dependent payloads", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post("loan-apply", { user_id: "11", amount_desired: 1 })).status, 201);
  state.role = "MEMBER";
  const result = await post("loan-apply", { amount_desired: 1 });
  assert.equal(result.status, 201);
  assert.equal(result.body.loan_application.user_id, "10");
  state.role = "AUDITOR";
  assert.equal((await post("loan-apply", { amount_desired: 1 })).status, 403);
});

test("latest own application is scoped to the caller and group for every role across cycles", async t => {
  const { state, get } = fixture(t);
  state.latest = { id: "101", user_id: "10", group_id: "1", cycle_id: "19", amount_desired: "500.00", status: "active" };
  state.cycle = false;
  for (const role of ["OWNER", "ADMIN", "TREASURER", "MEMBER", "AUDITOR"]) {
    state.role = role;
    const result = await get();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { success: true, loan_application: state.latest });
  }
  assert.equal(state.writes.length, 0);
});

test("latest own application returns null when absent and enforces authentication and membership", async t => {
  const { state, get } = fixture(t);
  assert.deepEqual(await get(), { status: 200, body: { success: true, loan_application: null } });
  assert.equal((await get("")).status, 401);
  state.actor = false;
  assert.equal((await get()).status, 403);
  state.actor = true;
  state.readError = new Error("private database details");
  const result = await get();
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Internal server error");
  assert.equal(state.writes.length, 0);
});
