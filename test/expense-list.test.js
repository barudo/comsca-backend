const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", rows: [], queries: [], error: null };
  Object.defineProperty(db, "transaction", { value: async fn => fn(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    state.queries.push(query);
    if (query.sql.includes('from "groups"')) return { id: query.bindings[0] === "alpha" ? "1" : "2" };
    if (query.sql.startsWith("SET TRANSACTION")) {
      assert.equal(query.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return {};
    }
    if (query.sql.includes('from "users"')) {
      assert.deepEqual(query.bindings.slice(0, 1), ["verified-user"]);
      return query.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    assert.equal(query.sql, 'select * from "transactions" where "group_id" = ? and "type" = ? order by "occurred_at" desc, "id" desc');
    assert.deepEqual(query.bindings, ["1", "EXPENSE"]);
    if (state.error) throw state.error;
    return state.rows;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "verified-user" }) }));
  const get = async (headers = {}) => {
    const result = await handler({
      version: "2.0", rawPath: "/api/v1/transactions/expenses",
      rawQueryString: "group_id=2&cycle_id=999&type=DONATION",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } },
    }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, get };
}

test("expense list uses group/type filtering and descending occurrence/id order for all group roles", async t => {
  const { state, get } = fixture(t);
  state.rows = [
    { id: "22", group_id: "1", type: "EXPENSE", cycle_id: "20", occurred_at: "2026-10-15T10:00:00Z", amount: "9007199254740993.01", document_type: "JOURNAL_VOUCHER", document_number: "9007199254740993", expense_payment_status: "PAID", status: "active" },
    { id: "21", group_id: "1", type: "EXPENSE", cycle_id: "19", occurred_at: "2026-10-15T10:00:00Z", expense_payment_status: "UNPAID", status: "voided" },
    { id: "20", group_id: "1", type: "EXPENSE", cycle_id: "18", occurred_at: "2026-10-14T10:00:00Z", expense_payment_status: null },
  ];
  for (const role of ["OWNER", "ADMIN", "TREASURER", "AUDITOR", "MEMBER"]) {
    state.role = role;
    assert.deepEqual(await get(), { status: 200, body: { success: true, data: state.rows } });
  }
});

test("expense list returns an empty array when no expenses exist", async t => {
  const { get } = fixture(t);
  assert.deepEqual(await get(), { status: 200, body: { success: true, data: [] } });
});

test("expense list requires authentication, a group header and membership before reading transactions", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get({ authorization: "" })).status, 401);
  assert.equal((await get({ "x-group-slug": "" })).status, 400);
  assert.equal((await get({ "x-group-slug": "beta" })).status, 403);
  assert.ok(!state.queries.some(query => query.sql.includes('from "transactions"')));
});

test("expense list does not expose database errors", async t => {
  const { state, get } = fixture(t);
  state.error = new Error("private database details");
  assert.deepEqual(await get(), { status: 500, body: { success: false, error: "Internal server error" } });
});
