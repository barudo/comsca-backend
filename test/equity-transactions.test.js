const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: true, member: true, membership: true, error: null,
    accounts: [{ id: "101", cycle_id: "20", type: "ASSET" }, { id: "106", cycle_id: "20", type: "EQUITY" }],
    writes: [], queries: [] };
  let header;
  Object.defineProperty(db, "transaction", { value: async fn => {
    const before = state.writes.length;
    try { const result = await fn(db); if (state.error) throw state.error; return result; }
    catch (error) { state.writes.length = before; throw error; }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return q.bindings[0] === "alpha" ? { id: "1" } : q.bindings[0] === "beta" ? { id: "2" } : undefined;
    if (q.sql.includes('from "users"')) {
      assert.match(q.sql, /for share/);
      if (q.sql.includes('"auth_user_id"')) return q.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
      assert.deepEqual(q.bindings, ["11", "1", 1]);
      return state.member ? { id: "11" } : undefined;
    }
    if (q.sql.includes('from "accounts"')) {
      assert.match(q.sql, /"group_id" = \?.*for share/);
      assert.deepEqual(q.bindings, ["1", "101", "106"]);
      return state.accounts;
    }
    if (q.sql.includes('from "cycles"')) { assert.equal(q.bindings[1], "1"); return state.cycle ? { id: q.bindings[0] } : undefined; }
    if (q.sql.includes('from "cycle_members"')) { assert.deepEqual(q.bindings, ["11", "20", 1]); return state.membership ? { user_id: "11" } : undefined; }
    if (q.method === "insert") {
      const rows = [builder._single.insert].flat().map((row, i) => ({ id: String(200 + state.writes.length + i), ...row }));
      state.writes.push({ table: builder._single.table, rows });
      if (builder._single.table === "transactions") header = rows[0];
      return rows;
    }
    assert.match(q.sql, /from "transactions"/);
    return header;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user", user_metadata: { role: "OWNER" } }) }));
  const post = async (body = {}, headers = {}, rawBody) => {
    const result = await handler({ version: "2.0", rawPath: "/api/v1/transactions/equity", rawQueryString: "group_id=2",
      headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: rawBody ?? JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, post };
}
const input = { debit: "101", credit: "106", amount: "500.00" };

test("equity POST atomically translates account IDs into signed postings", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post({ ...input, user_id: "11", description: "Capital contribution" });
    assert.equal(result.status, 201);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.transaction.type, "EQUITY");
    assert.equal(result.body.transaction.cycle_id, "20");
    assert.equal(result.body.transaction.user_id, "11");
    assert.equal(result.body.entries.length, 1);
    assert.deepEqual(result.body.account_entries.map(p => [p.account_id, p.amount]), [["101", "500.00"], ["106", "-500.00"]]);
  }
  const result = await post({ ...input, debit: 101, credit: 106, amount: 0.01 });
  assert.equal(result.body.transaction.amount, "0.01");
  assert.equal(result.body.transaction.user_id, null);
  assert.equal((await post({ ...input, amount: "9999999999999999.99" })).body.transaction.amount, "9999999999999999.99");
});

test("equity POST rejects malformed money, IDs and unsupported fields without writes", async t => {
  const { state, post } = fixture(t);
  for (const amount of [0, -1, "NaN", "Infinity", "1e3", "0.001", "10000000000000000", true, {}, null, 9007199254740991]) {
    assert.equal((await post({ ...input, amount })).status, 400, String(amount));
  }
  for (const debit of [null, [], [101], {}, 1.5, 0, -1, "9223372036854775808", "01", "106"]) {
    assert.equal((await post({ ...input, debit })).status, 400);
  }
  for (const body of [null, [], {}, { ...input, group_id: "2" }, { ...input, type: "PAYMENT" },
    { ...input, description: "\u0000" }, { ...input, description: "x".repeat(4001) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(input, {}, '{"debit":"101","credit":"106","amount":90071992547409.91}')).status, 400);
  assert.equal(state.writes.length, 0);
});

test("equity POST verifies financial writer role and group membership", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, { authorization: "" })).status, 401);
  assert.equal((await post(input, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(input, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "AUDITOR", null, "owner"]) {
    state.role = role; assert.equal((await post(input)).status, 403);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.queries.some(q => q.sql.includes('from "accounts"')), false);
});

test("equity POST enforces account types, cycle consistency and optional member rules", async t => {
  const { state, post } = fixture(t);
  state.accounts[0].type = "INCOME";
  assert.equal((await post(input)).status, 400);
  state.accounts[0].type = "ASSET";
  state.accounts[1].type = "LIABILITY";
  assert.equal((await post(input)).status, 400);
  state.accounts[1].type = "EQUITY";
  assert.equal((await post({ ...input, cycle_id: "99" })).status, 400);
  state.accounts[1].cycle_id = "99";
  assert.equal((await post(input)).status, 400);
  state.accounts[1].cycle_id = "20";
  state.member = false;
  assert.equal((await post({ ...input, user_id: "11" })).status, 404);
  state.member = true; state.membership = false;
  assert.equal((await post({ ...input, user_id: "11" })).status, 400);
  state.accounts.forEach(a => { a.cycle_id = null; });
  assert.equal((await post({ ...input, user_id: "11" })).status, 400);
  assert.equal((await post(input)).body.transaction.cycle_id, null);
  state.cycle = false;
  assert.equal((await post({ ...input, cycle_id: "20" })).status, 404);
  state.accounts = [];
  assert.equal((await post(input)).status, 404);
});

test("equity POST waits for commit and sanitizes constraint and server errors", async t => {
  const { state, post } = fixture(t);
  for (const code of ["23503", "23514", "40001", "40P01"]) {
    state.error = Object.assign(new Error("private error"), { code });
    const result = await post(input);
    assert.equal(result.status, 409);
    assert.equal(state.writes.length, 0);
    assert.doesNotMatch(result.body.error, /private/);
  }
  state.error = new Error("private server details");
  const result = await post(input);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Internal server error");
});
