const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", actor: true, cycle: true, member: true, membership: true, writes: [] };
  state.updates = [];
  Object.defineProperty(db, "transaction", { value: async fn => {
    const writes = state.writes.length;
    const updates = state.updates.length;
    try { return await fn(db); }
    catch (error) {
      state.writes.length = writes;
      state.updates.length = updates;
      throw error;
    }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL();
    const table = builder._single?.table;
    if (q.method === "raw") {
      assert.equal(q.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return {};
    }
    if (table === "users as u") {
      assert.deepEqual(q.bindings, ["1", "20"]);
      assert.match(q.sql, /inner join "cycle_members" as "cm" on "cm"\."user_id" = "u"\."id"/);
      assert.doesNotMatch(q.sql, /password|auth_user_id/);
      return state.roster || [];
    }
    if (table === "groups") return { id: "1" };
    if (table === "users") {
      assert.equal(q.bindings[1], "1");
      if (q.sql.includes('"auth_user_id"')) return state.actor ? { id: "10", role: state.role } : undefined;
      return state.member ? { id: q.bindings[0] } : undefined;
    }
    if (table === "cycles") {
      assert.deepEqual(q.bindings, q.sql.includes("for update") ? ["1", "draft", "active", 1] : ["1", "draft", "active", "distributing", 1]);
      return state.cycle ? { id: "20" } : undefined;
    }
    if (table === "cycle_members") {
      assert.equal(q.bindings[1], "20");
      return state.membership ? { user_id: q.bindings[0] } : undefined;
    }
    assert.equal(table, "loan_applications");
    if (q.method === "update") {
      assert.deepEqual(q.bindings, ["inactive", "1", "11", "active"]);
      assert.match(q.sql, /"updated_at" = CURRENT_TIMESTAMP/);
      assert.doesNotMatch(q.sql, /cycle_id/);
      state.updates.push(q);
      return 2;
    }
    if (q.method === "select") {
      assert.deepEqual(q.bindings, ["1", "20", "active"]);
      assert.match(q.sql, /select distinct on \("user_id"\) \*/);
      assert.match(q.sql, /order by "user_id" asc, "created_at" desc, "id" desc/);
      return state.applications || [];
    }
    if (q.method === "first") {
      assert.deepEqual(q.bindings, ["1", "10", "active", 1]);
      assert.match(q.sql, /order by "created_at" desc, "id" desc limit \?/);
      assert.doesNotMatch(q.sql, /"cycle_id" =/);
      if (state.readError) throw state.readError;
      return state.latest;
    }
    assert.equal(q.method, "insert");
    if (state.insertError) throw state.insertError;
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
  const list = (authorization) => post("loans/apply", undefined, authorization, "GET");
  return { state, post, get, list };
}

test("managed loan applications allow financial writers and persist the selected applicant", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post("loans/apply", { user_id: "11", amount_desired: 2000 });
    assert.equal(result.status, 201);
    assert.deepEqual(state.writes.at(-1), { group_id: "1", user_id: "11", cycle_id: "20", amount_desired: "2000.00", status: "active" });
    assert.equal(result.body.loan_application.user_id, "11");
  }
  for (const role of ["MEMBER", "AUDITOR"]) {
    state.role = role;
    assert.equal((await post("loans/apply", { user_id: "11", amount_desired: 2000 })).status, 403);
  }
  assert.equal(state.writes.length, 3);
  assert.equal(state.updates.length, 3);
});

test("managed application deactivation rolls back on failed insert and follows validation", async t => {
  const { state, post } = fixture(t);
  state.membership = false;
  assert.equal((await post("loans/apply", { user_id: "11", amount_desired: 1 })).status, 400);
  assert.equal(state.updates.length, 0);
  state.membership = true;
  state.insertError = Object.assign(new Error("insert failed"), { code: "23514" });
  assert.equal((await post("loans/apply", { user_id: "11", amount_desired: 1 })).status, 409);
  assert.equal(state.updates.length, 0);
  assert.equal(state.writes.length, 0);
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

test("cycle applications include every member with their latest application or null", async t => {
  const { state, list } = fixture(t);
  state.roster = [{ id: "10", first_name: "Anne" }, { id: "11", first_name: "Ben" }];
  const application = { id: "101", user_id: "10", cycle_id: "20", amount_desired: "2000.00", status: "active" };
  state.applications = [application];
  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR"]) {
    state.role = role;
    assert.deepEqual(await list(), {
      status: 200,
      body: { success: true, current_cycle_id: "20", members: [
        { ...state.roster[0], loan_application: application },
        { ...state.roster[1], loan_application: null },
      ] },
    });
  }
  assert.equal(state.writes.length, 0);
});

test("cycle application listing handles empty cycles and requires a financial group role", async t => {
  const { state, list } = fixture(t);
  assert.deepEqual(await list(), { status: 200, body: { success: true, current_cycle_id: "20", members: [] } });
  state.cycle = false;
  assert.deepEqual(await list(), { status: 200, body: { success: true, current_cycle_id: null, members: [] } });
  assert.equal((await list("")).status, 401);
  state.role = "MEMBER";
  assert.equal((await list()).status, 403);
  state.role = "OWNER";
  state.actor = false;
  assert.equal((await list()).status, 403);
  assert.equal(state.writes.length, 0);
});
