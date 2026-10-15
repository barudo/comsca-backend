const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");
const input = { expenses: [{ id: "10", amount: "100" }, { id: "11", amount: "200" }], debit: "201", credit: "100" };

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = {
    role: "OWNER", cycle: true, counter: "0", sufficient: true, prior: false, error: null, failTable: null,
    expenses: ["10", "11"].map((id, i) => ({ id, group_id: "1", cycle_id: "20", type: "EXPENSE", status: "active", expense_payment_status: "UNPAID", amount: `${(i + 1) * 100}.00` })),
    accounts: [{ id: "201", cycle_id: "20", type: "LIABILITY" }, { id: "100", cycle_id: "20", type: "ASSET" }],
    postings: [{ transaction_id: "10", account_id: "201", amount: "-100.00" }, { transaction_id: "11", account_id: "201", amount: "-200.00" }],
    writes: [], queries: [],
  };
  let header;
  const builders = new WeakSet();
  const trx = table => { const builder = db(table); builders.add(builder); return builder; };
  trx.fn = db.fn;
  trx.raw = (...args) => { const builder = db.raw(...args); builders.add(builder); return builder; };
  Object.defineProperty(db, "transaction", { value: async fn => {
    const before = structuredClone({ counter: state.counter, expenses: state.expenses, writes: state.writes });
    try {
      const result = await fn(trx);
      if (state.error) throw state.error;
      return result;
    } catch (error) {
      Object.assign(state, before);
      throw error;
    }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    if (q.sql.includes('from "groups"')) return { id: q.bindings[0] === "alpha" ? "1" : "2" };
    assert.ok(builders.has(builder), "all payment operations must use the transaction");
    if (q.sql.includes('from "users"')) return q.bindings[1] === "1" ? { id: "1", role: state.role } : undefined;
    if (q.sql.includes('from "cycles"')) {
      assert.deepEqual(q.bindings, ["1", "active", "distributing", 1]);
      assert.match(q.sql, /for update/);
      return state.cycle ? { id: "20" } : undefined;
    }
    if (q.sql.includes('from "transactions"') && q.sql.includes('for update')) {
      assert.deepEqual(q.bindings.slice(0, 3), ["1", "20", "EXPENSE"]);
      assert.match(q.sql, /order by "id" asc for update/);
      return state.expenses.filter(row => row.group_id === "1" && row.cycle_id === "20" && row.type === "EXPENSE" && q.bindings.slice(3).includes(row.id));
    }
    if (q.sql.includes('from "expense_payments"')) return state.prior ? { expense_transaction_id: "10" } : undefined;
    if (q.sql.includes('from "accounts"')) {
      assert.equal(q.bindings[0], "1");
      assert.match(q.sql, /for share/);
      return state.accounts.filter(row => q.bindings.slice(1).includes(row.id));
    }
    if (q.sql.includes('from "account_entries" as "p"')) {
      assert.deepEqual(q.bindings, ["1", "10", "11", 0]);
      assert.match(q.sql, /"e"\."group_id" = "p"\."group_id"/);
      return state.postings;
    }
    if (q.sql.includes("AS sufficient")) {
      assert.deepEqual(q.bindings.slice(1), ["1", "100"]);
      state.checkedAmount = q.bindings[0];
      return { rows: [{ sufficient: state.sufficient }] };
    }
    const table = builder._single.table;
    if (["insert", "update"].includes(q.method)) {
      if (state.failTable === table) throw Object.assign(new Error("private write error"), { code: "23514" });
      if (table === "cycles") {
        assert.deepEqual(q.bindings, [1, "20", "1"]);
        assert.match(q.sql, /"disbursement_voucher_counter" = "disbursement_voucher_counter" \+ \?/);
        if (state.counter === "9223372036854775807") throw Object.assign(new Error("overflow"), { code: "22003" });
        state.counter = String(BigInt(state.counter) + 1n);
        return [{ disbursement_voucher_counter: state.counter }];
      }
      if (q.method === "update") {
        if (state.failStatusUpdate) throw Object.assign(new Error("status update failed"), { code: "23514" });
        assert.equal(table, "transactions");
        assert.match(q.sql, /"expense_payment_status" = \?/);
        assert.deepEqual(q.bindings, ["PAID", "1", "20", "EXPENSE", "UNPAID", "10", "11"]);
        state.expenses.forEach(row => { row.expense_payment_status = "PAID"; });
        state.writes.push({ table, update: true });
        return state.expenses.length;
      }
      const rows = [builder._single.insert].flat().map((row, i) => ({ id: String(500 + state.writes.length + i), ...row }));
      state.writes.push({ table, rows });
      if (table === "transactions") header = rows[0];
      return rows;
    }
    assert.match(q.sql, /from "transactions"/);
    return header;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user" }) }));
  const post = async (body = input, headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: "/api/v1/transactions/expenses/pay", rawQueryString: "group_id=2",
      headers: { authorization: "Bearer token", "x-group-slug": "alpha", "content-type": "application/json", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { state, post };
}

test("batch expense payment posts exact total, links expenses, and marks them paid for financial writers", async t => {
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    const { state, post } = fixture(t); state.role = role;
    state.counter = "9007199254740992";
    const result = await post();
    assert.equal(result.status, 201);
    assert.equal(result.body.transaction.type, "EXPENSE_PAYMENT");
    assert.equal(result.body.transaction.amount, "300.00");
    assert.equal(state.checkedAmount, "300.00");
    assert.equal(result.body.transaction.document_type, "DISBURSEMENT_VOUCHER");
    assert.equal(result.body.transaction.document_number, "9007199254740993");
    assert.equal(result.body.entries.length, 1);
    assert.deepEqual(result.body.account_entries.map(row => [row.account_id, row.amount]), [["201", "300.00"], ["100", "-300.00"]]);
    assert.deepEqual(result.body.expense_payments.map(row => [row.expense_transaction_id, row.amount]), [["10", "100.00"], ["11", "200.00"]]);
    assert.ok(result.body.expense_payments.every(row => row.payment_transaction_id === result.body.transaction.id));
    assert.ok(state.expenses.every(row => row.expense_payment_status === "PAID"));
    assert.deepEqual(state.expenses.map(row => row.amount), ["100.00", "200.00"]);
    assert.equal((await post()).status, 409);
  }
});

test("expense payments reject malformed, duplicate, partial and excessive amounts", async t => {
  const { state, post } = fixture(t);
  for (const body of [null, [], {}, { ...input, expenses: [] }, { ...input, debit: "100" }, { ...input, amount: "300" },
    { ...input, expenses: Array(101).fill(input.expenses[0]) }, { ...input, expenses: [input.expenses[0], { id: 10, amount: 100 }] },
    ...[0, -1, "NaN", "1e3", "1.001", true, null, {}, "10000000000000000", 1000000000001].map(amount => ({ ...input, expenses: [{ id: "10", amount }] })),
    ...[null, "01", "9223372036854775808", [], 1.5].map(id => ({ ...input, expenses: [{ id, amount: "100" }] })),
    { ...input, expenses: [{ id: "10", amount: "9999999999999999.99" }, { id: "11", amount: ".01" }] },
    { ...input, expenses: [{ id: "10", amount: "9999999999999999.99" }, { id: "11", amount: "0.01" }] },
    { ...input, expenses: [{ ...input.expenses[0], other: true }] },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  for (const amount of ["99.99", "100.01"]) assert.equal((await post({ ...input, expenses: [{ id: "10", amount }, input.expenses[1]] })).status, 409);
  assert.equal(state.writes.length, 0); assert.equal(state.counter, "0");
});

test("expense payments enforce authorization, current cycle, expense state and funding account", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, { authorization: "" })).status, 401);
  assert.equal((await post(input, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(input, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "AUDITOR"]) { state.role = role; assert.equal((await post()).status, 403); }
  state.role = "OWNER"; state.cycle = false; assert.equal((await post()).status, 409); state.cycle = true;
  for (const [field, value, status] of [["group_id", "2", 404], ["cycle_id", "19", 404], ["type", "DONATION", 404],
    ["status", "voided", 409], ["expense_payment_status", "PAID", 409], ["expense_payment_status", null, 409]]) {
    const old = state.expenses[0][field]; state.expenses[0][field] = value;
    assert.equal((await post()).status, status); state.expenses[0][field] = old;
  }
  state.prior = true; assert.equal((await post()).status, 409); state.prior = false;
  assert.equal((await post({ ...input, credit: "999" })).status, 404);
  for (const account of state.accounts) {
    for (const [field, value] of [["cycle_id", "19"], ["cycle_id", null], ["type", "INCOME"]]) {
      const old = account[field]; account[field] = value; assert.equal((await post()).status, 400); account[field] = old;
    }
  }
  state.postings[0].account_id = "202"; assert.equal((await post()).status, 409); state.postings[0].account_id = "201";
  state.postings[0].amount = "-99.00"; assert.equal((await post()).status, 409); state.postings[0].amount = "-100.00";
  state.sufficient = false; assert.equal((await post()).status, 409);
  assert.equal(state.counter, "0"); assert.equal(state.writes.length, 0);
});

test("expense payment rolls back voucher, ledger, links and statuses on failure", async t => {
  const { state, post } = fixture(t);
  for (const table of ["cycles", "transactions", "transaction_entries", "account_entries", "expense_payments"]) {
    state.failTable = table;
    assert.equal((await post()).status, 409);
    assert.equal(state.counter, "0"); assert.equal(state.writes.length, 0);
    assert.ok(state.expenses.every(row => row.expense_payment_status === "UNPAID"));
  }
  state.failTable = null;
  state.failStatusUpdate = true;
  assert.equal((await post()).status, 409);
  assert.equal(state.counter, "0"); assert.equal(state.writes.length, 0);
  assert.ok(state.expenses.every(row => row.expense_payment_status === "UNPAID"));
  state.failStatusUpdate = false;
  for (const code of ["23505", "40001", "40P01", undefined]) {
    state.error = Object.assign(new Error("private failure"), { code });
    const result = await post();
    assert.equal(result.status, code ? 409 : 500);
    assert.doesNotMatch(result.body.error, /private/);
    assert.equal(state.counter, "0"); assert.equal(state.writes.length, 0);
    assert.ok(state.expenses.every(row => row.expense_payment_status === "UNPAID"));
  }
  state.error = null; state.counter = "9223372036854775807";
  assert.equal((await post()).status, 409);
  assert.equal(state.counter, "9223372036854775807"); assert.equal(state.writes.length, 0);
});

test("expense payments preserve large decimal totals and accept normalized numeric IDs and amounts", async t => {
  const { state, post } = fixture(t);
  state.expenses[0].amount = "9007199254740993.01";
  state.expenses[1].amount = "0.01";
  state.postings[0].amount = "-9007199254740993.01";
  state.postings[1].amount = "-0.01";
  const result = await post({ debit: 201, credit: 100, expenses: [{ id: 10, amount: "9007199254740993.01" }, { id: 11, amount: 0.01 }] });
  assert.equal(result.status, 201);
  assert.equal(result.body.transaction.amount, "9007199254740993.02");
  assert.equal(result.body.account_entries[1].amount, "-9007199254740993.02");
  assert.equal(state.checkedAmount, "9007199254740993.02");
});
