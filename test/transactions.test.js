const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", header: { id: "42", group_id: "1", cycle_id: "20", status: "active", amount: "9999999999999999.99", document_number: "9007199254740993" }, reversals: 0, queries: [], link: false, error: null };
  Object.defineProperty(db, "transaction", { value: async fn => {
    const before = { header: { ...state.header }, reversals: state.reversals };
    try { const result = await fn(db); if (state.error) throw state.error; return result; }
    catch (error) { Object.assign(state, before); throw error; }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return { id: q.bindings[0] === "alpha" ? "1" : "2" };
    if (q.sql.includes('from "users"')) return { id: "7", role: state.role };
    if (q.sql.includes('from "cycles"')) { assert.match(q.sql, /for update$/); return { id: "20" }; }
    if (q.sql.includes('from "transactions"')) {
      assert.deepEqual(q.bindings, [state.header.group_id === "1" ? q.bindings[0] : "1", q.bindings[1], 1]);
      return q.bindings[0] === state.header.group_id && q.bindings[1] === state.header.id ? { ...state.header } : undefined;
    }
    if (q.sql.includes('from "expense_payments"')) { assert.equal(q.bindings[0], "1"); return state.link ? { expense_transaction_id: "99" } : undefined; }
    if (q.sql.startsWith('INSERT INTO account_entries')) {
      assert.match(q.sql, /-p.amount, p.id/);
      assert.deepEqual(q.bindings, ["1", "1", "42"]);
      const locks = state.queries.filter(q => /for update$/.test(q.sql));
      assert.ok(locks[0].sql.includes('"cycles"')); assert.ok(locks[1].sql.includes('"transactions"'));
      state.reversals += 2; return {};
    }
    assert.match(q.sql, /^update "transactions"/);
    assert.deepEqual(q.bindings, ["voided", "1", "42"]);
    state.header.status = "voided"; return [{ ...state.header }];
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth" }) }));
  const remove = async (id = "42", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: `/api/v1/transactions/${id}`, rawQueryString: "group_id=2",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "DELETE", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, remove };
}

test("void is atomic, preserves precision/documents, locks cycle first and repeats safely", async t => {
  const { state, remove } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    assert.deepEqual(await remove(), { status: 200, body: { success: true, transaction: { ...state.header, status: "voided" } } });
  }
  assert.equal(state.reversals, 2);
});
test("void requires authentication and OWNER/ADMIN membership", async t => {
  const { state, remove } = fixture(t);
  assert.equal((await remove("42", { authorization: "" })).status, 401);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", null]) { state.role = role; assert.equal((await remove()).status, 403); }
  assert.equal(state.reversals, 0);
});
test("invalid, missing and other-group IDs never write", async t => {
  const { state, remove } = fixture(t);
  for (const id of ["0", "-1", "01", "1.5", "abc", "9223372036854775808"]) assert.equal((await remove(id)).status, 400);
  assert.equal((await remove("99")).status, 404);
  assert.equal((await remove("42", { "x-group-slug": "beta" })).status, 404);
  assert.equal(state.reversals, 0);
});
test("paid expenses and linked expense payments are rejected", async t => {
  const { state, remove } = fixture(t);
  Object.assign(state.header, { type: "EXPENSE", expense_payment_status: "PAID" });
  assert.equal((await remove()).status, 409);
  Object.assign(state.header, { type: "EXPENSE_PAYMENT", expense_payment_status: null }); state.link = true;
  assert.equal((await remove()).status, 409); assert.equal(state.reversals, 0);
});
test("commit failure rolls back postings and status and sanitizes errors", async t => {
  const { state, remove } = fixture(t);
  for (const code of ["23514", "40001", undefined]) {
    state.error = Object.assign(new Error("private details"), { code });
    assert.equal((await remove()).status, code ? 409 : 500);
    assert.equal(state.header.status, "active"); assert.equal(state.reversals, 0);
  }
});
