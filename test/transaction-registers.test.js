const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", member: true, total: "0", rows: [], queries: [], error: null };
  Object.defineProperty(db, "transaction", { value: async fn => fn(db) });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return { id: q.bindings[0] === "alpha" ? "1" : "2" };
    if (q.sql.startsWith("SET TRANSACTION")) {
      assert.equal(q.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"); return {};
    }
    if (q.sql.includes('from "users"')) {
      assert.equal(q.bindings[0], "auth-user");
      return state.member && q.bindings[1] === "1" ? { id: "1", role: state.role } : undefined;
    }
    assert.match(q.sql, /from "transactions" where "group_id" = \? and "document_type" in .* and "document_number" is not null/);
    assert.equal(q.bindings[0], "1");
    if (state.error) throw state.error;
    if (q.sql.includes("count(*)")) return { total: state.total };
    return state.rows;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user" }) }));
  const get = async (query = "", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: "/api/v1/transactions/registers", rawQueryString: query,
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, get };
}

test("registers default to all numbered documents, descending dates and paginated response", async t => {
  const { state, get } = fixture(t);
  state.total = "26";
  state.rows = [{ id: "9007199254740993", document_number: "9007199254740993", amount: "9999999999999999.99", document_type: "JOURNAL_VOUCHER", status: "voided" }];
  const result = await get("group_id=2&cycle_id=999");
  assert.deepEqual(result, { status: 200, body: { success: true, data: state.rows, pagination: { page: 1, per_page: 25, total: 26, total_pages: 2 } } });
  const queries = state.queries.filter(q => q.sql.includes('from "transactions"'));
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].bindings, ["1", "RECEIPT", "PAYMENT_RECEIPT", "DISBURSEMENT_VOUCHER", "JOURNAL_VOUCHER", 1]);
  assert.match(queries[1].sql, /order by "occurred_at" desc nulls last, "id" desc limit \?/);
  assert.deepEqual(queries[1].bindings, ["1", "RECEIPT", "PAYMENT_RECEIPT", "DISBURSEMENT_VOUCHER", "JOURNAL_VOUCHER", 25]);
});

test("registers map PR DV JV filters and preserve matching count and page scopes", async t => {
  const { state, get } = fixture(t);
  state.role = "ADMIN"; state.total = "5";
  for (const [document, types] of [["PR", ["RECEIPT", "PAYMENT_RECEIPT"]], ["DV", ["DISBURSEMENT_VOUCHER"]], ["JV", ["JOURNAL_VOUCHER"]]]) {
    state.queries = [];
    const result = await get(`document=${document}&per_page=2&page=2&sorty_by=document_number&order=asc`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.pagination, { page: 2, per_page: 2, total: 5, total_pages: 3 });
    const queries = state.queries.filter(q => q.sql.includes('from "transactions"'));
    assert.deepEqual(queries[0].bindings, ["1", ...types, 1]);
    assert.deepEqual(queries[1].bindings, ["1", ...types, 2, 2]);
    assert.match(queries[1].sql, /order by "document_number" asc nulls last, "id" asc limit \? offset \?/);
  }
  assert.equal((await get("document=")).status, 200);
});

test("registers support whitelisted sorts and empty/out-of-range pages", async t => {
  const { state, get } = fixture(t);
  for (const column of ["id", "occurred_at", "created_at", "updated_at", "document_number", "document_type", "amount", "type", "status", "cycle_id"]) {
    assert.equal((await get(`sort_by=${column}&order=asc`)).status, 200);
    const query = state.queries.at(-1);
    assert.ok(query.sql.includes(`order by "${column}" asc nulls last`));
    if (column === "id") assert.doesNotMatch(query.sql, /, "id"/);
  }
  const empty = await get("page=100&per_page=100");
  assert.deepEqual(empty.body, { success: true, data: [], pagination: { page: 100, per_page: 100, total: 0, total_pages: 0 } });
  assert.equal((await get("sorty_by=id&sort_by=id")).status, 200);
});

test("registers reject invalid pagination, filters, ordering and injected columns before transaction queries", async t => {
  const { state, get } = fixture(t);
  for (const query of ["document=OTHER", "document=pr", "document=PR&document=DV", "per_page=0", "per_page=-1", "per_page=101", "per_page=1.5", "per_page=", "page=0", "page=NaN", "page=9007199254740992", "page=9007199254740991&per_page=100", "order=DESC", "order=desc%3BDROP", "sorty_by=amount%3BDROP", "sorty_by=unknown", "sorty_by=id&sort_by=amount", "sorty_by=id&sorty_by=amount", "per_page=2&per_page=3", "page=1&page=2"]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.ok(!state.queries.some(q => q.sql.includes('from "transactions"')));
});

test("registers only allow OWNER and ADMIN in the selected group", async t => {
  const { state, get } = fixture(t);
  assert.equal((await get("", { authorization: "" })).status, 401);
  assert.equal((await get("", { "x-group-slug": "" })).status, 400);
  assert.equal((await get("", { "x-group-slug": "beta" })).status, 403);
  for (const role of ["TREASURER", "AUDITOR", "MEMBER", "owner", null]) {
    state.role = role; assert.equal((await get()).status, 403);
  }
  state.role = "OWNER"; state.member = false; assert.equal((await get()).status, 403);
  assert.ok(!state.queries.some(q => q.sql.includes('from "transactions"')));
});

test("registers sanitize database failures", async t => {
  const { state, get } = fixture(t); state.error = new Error("private details");
  assert.deepEqual(await get(), { status: 500, body: { success: false, error: "Internal server error" } });
});
