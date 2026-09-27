const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: { id: "20" }, users: ["11", "12", "9007199254740993"], members: new Set(), queries: [], error: null };
  Object.defineProperty(db, "transaction", { value: async fn => {
    const before = new Set(state.members);
    try { const result = await fn(db); if (state.error) throw state.error; return result; }
    catch (error) { state.members = before; throw error; }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return q.bindings[0] === "alpha" ? { id: "1" } : q.bindings[0] === "beta" ? { id: "2" } : undefined;
    if (q.sql.includes('"auth_user_id"')) {
      assert.match(q.sql, /for share$/);
      return q.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    if (q.sql.includes('from "cycles"')) {
      assert.match(q.sql, /for update$/);
      assert.deepEqual(q.bindings, ["1", "draft", "active", "distributing", 1]);
      return state.cycle;
    }
    if (q.sql.includes('from "users"')) {
      assert.match(q.sql, /"group_id" = \?.*order by "id" asc for share$/);
      assert.equal(q.bindings[0], "1");
      return state.users.filter(id => q.bindings.slice(1).includes(id)).map(id => ({ id }));
    }
    assert.match(q.sql, /^insert into "cycle_members".*on conflict \("cycle_id", "user_id"\) do nothing returning "user_id"$/);
    const added = [];
    for (const row of builder._single.insert) {
      assert.equal(row.cycle_id, "20");
      if (!state.members.has(row.user_id)) { state.members.add(row.user_id); added.push({ user_id: row.user_id }); }
    }
    return added;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "verified", user_metadata: { role: "OWNER" } }) }));
  const post = async (body = { users: [11, "12"] }, headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: "/api/v1/cycles/members", rawQueryString: "cycle_id=999&group_id=2",
      headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, post };
}

test("cycle membership enrollment deduplicates, adds missing members and permits safe retries", async t => {
  const { state, post } = fixture(t);
  const result = await post({ users: [11, "11", "12", "9007199254740993"] });
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.body, { success: true, current_cycle_id: "20", users: ["11", "12", "9007199254740993"], added_count: 3 });
  state.role = "ADMIN";
  assert.equal((await post()).body.added_count, 0);
  assert.equal(state.members.size, 3);
});

test("cycle enrollment rejects invalid requests before touching memberships", async t => {
  const { state, post } = fixture(t);
  for (const body of [null, [], {}, { users: [] }, { users: "11" }, { users: [11], cycle_id: 999 },
    { users: Array(1001).fill(11) }, ...[0,-1,1.5,"01","9223372036854775808",9007199254740992,null,{},[],true].map(id => ({ users: [id] }))]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(state.members.size, 0);
  assert.equal(state.queries.some(q => q.sql.includes('from "cycles"')), false);
});

test("cycle enrollment requires verified OWNER/ADMIN of the selected group", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(undefined, { authorization: "" })).status, 401);
  assert.equal((await post(undefined, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(undefined, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", null, "owner"]) {
    state.role = role; assert.equal((await post()).status, 403);
  }
  assert.equal(state.queries.some(q => q.sql.includes('from "cycles"')), false);
});

test("cycle enrollment rejects missing current cycle or any unavailable user atomically", async t => {
  const { state, post } = fixture(t);
  state.cycle = undefined;
  assert.equal((await post()).status, 409);
  state.cycle = { id: "20" };
  assert.equal((await post({ users: [11, "999"] })).status, 404);
  assert.equal(state.members.size, 0);
  assert.equal(state.queries.some(q => q.method === "insert"), false);
});

test("cycle enrollment only reports success after commit and sanitizes database failures", async t => {
  const { state, post } = fixture(t);
  for (const code of ["23503", "40001", "40P01"]) {
    state.error = Object.assign(new Error("private details"), { code });
    assert.equal((await post()).status, 409);
    assert.equal(state.members.size, 0);
  }
  state.error = new Error("private details");
  assert.deepEqual((await post()).body, { success: false, error: "Internal server error" });
});
