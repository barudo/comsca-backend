const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", member: true, bothGroups: false, parent: true, rows: [], queries: [], errorTable: null };
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL();
    state.queries.push(q);
    if (state.errorTable && q.sql.includes(`from "${state.errorTable}"`)) throw new Error("private database details");
    if (q.sql.includes('from "groups"')) return { id: q.bindings[0] === "alpha" ? "1" : "2" };
    if (q.sql.includes('from "users"')) {
      assert.deepEqual(q.bindings, ["auth-user", q.bindings[1], 1]);
      return state.member && (q.bindings[1] === "1" || state.bothGroups) ? { id: "7", role: state.role } : undefined;
    }
    if (q.sql.includes('from "transactions"')) {
      assert.match(q.sql, /where "group_id" = \? and "id" = \?/);
      const parentGroup = q.bindings[1] === "99" ? "2" : "1";
      return state.parent && q.bindings[0] === parentGroup ? { id: q.bindings[1] } : undefined;
    }
    assert.match(q.sql, /select \* from "transaction_entries" where "group_id" = \? and "transaction_id" = \? order by "id" asc/);
    assert.equal(q.bindings[0], "1");
    return state.rows;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user" }) }));
  const get = async (id = "42", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: `/api/v1/transactions/${id}/entries`,
      rawQueryString: "group_id=2&transaction_id=99",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, get };
}

test("OWNER and ADMIN receive the selected transaction entries with precision preserved", async t => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "9007199254740993", transaction_id: "9223372036854775807", group_id: "1", account_id: "8", debit: "123.45", credit: "0.00", description: "debit entry" },
    { id: "9007199254740994", transaction_id: "9223372036854775807", group_id: "1", account_id: "9", debit: "0.00", credit: "123.45", description: "credit entry" },
  ];
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    assert.deepEqual(await get("9223372036854775807"), { status: 200, body: { success: true, data: state.rows } });
    assert.deepEqual(state.queries.at(-1).bindings, ["1", "9223372036854775807"]);
  }
});

test("existing empty transactions return an empty array; missing and other-group transactions return 404", async t => {
  const { state, get } = fixture(t);
  assert.deepEqual(await get(), { status: 200, body: { success: true, data: [] } });
  state.queries = [];
  assert.equal((await get("99")).status, 404);
  state.bothGroups = true;
  assert.equal((await get("42", { "x-group-slug": "beta" })).status, 404);
  state.parent = false;
  assert.equal((await get()).status, 404);
  assert.ok(!state.queries.some(q => q.sql.includes('from "transaction_entries"')));
});

test("authentication and group membership restrict access before transaction reads", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get("42", { authorization: "" })).status, 401);
  assert.equal((await get("42", { "x-group-slug": "" })).status, 400);
  assert.equal((await get("42", { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", "owner", null]) {
    state.role = role;
    assert.equal((await get()).status, 403);
  }
  state.role = "OWNER";
  state.member = false;
  assert.equal((await get()).status, 403);
  assert.ok(!state.queries.some(q => /from "(transactions|transaction_entries)"/.test(q.sql)));
});

test("invalid transaction IDs are rejected before transaction queries", async t => {
  const { state, get } = fixture(t);
  for (const id of ["0", "-1", "01", "1.5", "abc", "1e2", "9223372036854775808", "99999999999999999999", "42%20OR%201=1"]) {
    assert.equal((await get(id)).status, 400, id);
  }
  assert.ok(!state.queries.some(q => /from "(transactions|transaction_entries)"/.test(q.sql)));
});

test("database failures are sanitized", async t => {
  const { state, get } = fixture(t);
  for (const table of ["users", "transactions", "transaction_entries"]) {
    state.errorTable = table;
    assert.deepEqual(await get(), { status: 500, body: { success: false, error: "Internal server error" } });
  }
});
