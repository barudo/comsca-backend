const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", cycle: true, cycleStatus: "active", member: true, membership: true, error: null,
    accounts: [{ id: "101", cycle_id: "20", type: "ASSET", code: "1000" },
      { id: "102", cycle_id: "20", type: "ASSET", code: "1100" },
      { id: "106", cycle_id: "20", type: "EQUITY", code: "3000" },
      { id: "107", cycle_id: "20", type: "ASSET", code: "1300" },
      { id: "108", cycle_id: "20", type: "INCOME", code: "4100" },
      { id: "109", cycle_id: "20", type: "ASSET", code: "1400" },
      { id: "110", cycle_id: "20", type: "ASSET", code: "1000" },
      { id: "111", cycle_id: "20", type: "INCOME", code: "4300" },
      { id: "120", cycle_id: "20", type: "EXPENSE", code: "5000" },
      { id: "121", cycle_id: "20", type: "LIABILITY", code: "2000" }],
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
      assert.equal(q.bindings[0], "1");
      return state.accounts.filter(account => (account.group_id ?? "1") === q.bindings[0] && q.bindings.slice(1).includes(account.id));
    }
    if (q.sql.includes('from "cycles"')) {
      if (q.sql.includes('"status" in')) {
        assert.deepEqual(q.bindings.slice(0, 3), ["1", "active", "distributing"]);
        return state.cycle && ["active", "distributing"].includes(state.cycleStatus) ? { id: "20" } : undefined;
      }
      assert.equal(q.bindings[1], "1");
      return state.cycle ? { id: q.bindings[0] } : undefined;
    }
    if (q.sql.includes('from "cycle_members"')) { assert.deepEqual(q.bindings, ["11", "20", 1]); return state.membership ? { user_id: "11" } : undefined; }
    if (q.method === "insert") {
      if (state.failTable === builder._single.table) throw state.writeError;
      const rows = [builder._single.insert].flat().map((row, i) => ({ id: String(200 + state.writes.length + i), ...row }));
      state.writes.push({ table: builder._single.table, rows });
      if (builder._single.table === "transactions") header = { occurred_at: "2026-10-03T08:12:34.567Z", ...rows[0] };
      return rows;
    }
    assert.match(q.sql, /from "transactions"/);
    return header;
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: "auth-user", user_metadata: { role: "OWNER" } }) }));
  const post = async (body = {}, headers = {}, rawBody, path = "/api/v1/transactions/payments") => {
    const result = await handler({ version: "2.0", rawPath: path, rawQueryString: "group_id=2",
      headers: { "content-type": "application/json", authorization: "Bearer token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } }, body: rawBody ?? JSON.stringify(body), isBase64Encoded: false }, {});
    return { status: result.statusCode, body: result.headers["content-type"]?.includes("application/json") ? JSON.parse(result.body) : result.body, headers: result.headers };
  };
  return { state, post };
}
const share = { type: "BUY_SHARE", debit: "101", credit: "106", amount: "500.00" };
const input = { user_id: "11", entries: [share] };
const component = changes => ({ ...input, entries: [{ ...share, ...changes }] });

test("payments POST creates a member PAYMENT and balanced component postings for financial writers", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    const result = await post({ ...input, description: "Member payment", entries: [
      { type: "LOAN_PAYMENT", debit: "101", credit: "102", amount: "600.10", description: "Loan repayment" },
      { ...share, amount: "300.20" },
      { type: "PENALTY_PAYMENT", debit: "101", credit: "107", amount: "100.01" },
      { type: "PAY_CONTRIBUTION", debit: "101", credit: "109", amount: "25.50" },
    ] });
    assert.equal(result.status, 201);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.transaction.type, "PAYMENT");
    assert.equal(result.body.transaction.amount, "1025.81");
    assert.equal(result.body.transaction.cycle_id, "20");
    assert.equal(result.body.transaction.user_id, "11");
    assert.equal(result.body.transaction.description, "Member payment");
    assert.deepEqual(result.body.entries.map(e => e.type), ["LOAN_PAYMENT", "BUY_SHARE", "PENALTY_PAYMENT", "PAY_CONTRIBUTION"]);
    assert.equal(result.body.entries[0].description, "Loan repayment");
    assert.deepEqual(result.body.account_entries.map(p => [p.account_id, p.amount]), [
      ["101", "600.10"], ["102", "-600.10"], ["101", "300.20"], ["106", "-300.20"], ["101", "100.01"], ["107", "-100.01"],
      ["101", "25.50"], ["109", "-25.50"],
    ]);
    for (const entry of result.body.entries) {
      assert.equal(entry.group_id, "1");
      assert.equal(entry.user_id, result.body.transaction.user_id);
      assert.equal(entry.cycle_id, result.body.transaction.cycle_id);
      assert.equal(entry.transaction_id, result.body.transaction.id);
      const postings = result.body.account_entries.filter(p => p.transaction_entry_id === entry.id);
      assert.equal(postings.length, 2);
      assert.ok(postings.every(p => p.group_id === "1"));
      assert.equal(postings[1].amount, `-${postings[0].amount}`);
    }
  }
  assert.equal((await post(component({ debit: 101, credit: 106, amount: 0.01 }))).body.transaction.amount, "0.01");
  assert.equal((await post(component({ amount: "9999999999999999.99" }))).body.transaction.amount, "9999999999999999.99");
  assert.equal((await post(component({ type: "PENALTY_PAYMENT", credit: "108" }))).status, 201);
  assert.equal((await post({ ...input, entries: Array.from({ length: 100 }, () => ({ ...share, amount: "0.01" })) })).body.transaction.amount, "1.00");
});

test("payments POST rejects invalid money and sum overflow before writes", async t => {
  const { state, post } = fixture(t);
  for (const amount of [undefined, 0, -1, "NaN", "Infinity", "1e3", "0.001", "10000000000000000", true, {}, null, 1000000000001]) {
    assert.equal((await post(component({ amount }))).status, 400, String(amount));
  }
  assert.equal((await post({ ...input, entries: [{ ...share, amount: "9999999999999999.99" }, { ...share, amount: "0.01" }] })).status, 400);
  assert.equal(state.writes.length, 0);
});

test("payments POST rejects oversized batches before any writes", async t => {
  const { state, post } = fixture(t);
  const result = await post({ ...input, entries: Array.from({ length: 9 }, () => ({ ...share, description: "x".repeat(4000) })) });
  assert.equal(result.status, 413);
  assert.equal(state.writes.length, 0);
});

test("payments POST sums large components without losing cents", async t => {
  const { post } = fixture(t);
  const result = await post({ ...input, entries: [{ ...share, amount: "9999999999999999.98" }, { ...share, amount: "0.01" }] });
  assert.equal(result.status, 201);
  assert.equal(result.body.transaction.amount, "9999999999999999.99");
});

test("payments POST rejects a later entry with foreign accounts or a different cycle", async t => {
  const { state, post } = fixture(t);
  const mixed = { ...input, entries: [share, { type: "LOAN_PAYMENT", debit: "101", credit: "999", amount: "1.00" }] };
  assert.equal((await post(mixed)).status, 404);
  state.accounts.push({ id: "999", cycle_id: "99", type: "ASSET", code: "1100" },
    { id: "998", cycle_id: "99", type: "ASSET", code: "1000" });
  mixed.entries[1].debit = "998";
  assert.equal((await post(mixed)).status, 400);
  assert.equal(state.writes.length, 0);
});

test("payments POST validates required member, entry collection, IDs, descriptions and unsupported fields", async t => {
  const { state, post } = fixture(t);
  for (const id of [null, [], [101], {}, 1.5, 0, -1, "9223372036854775808", "01"]) {
    assert.equal((await post(component({ debit: id }))).status, 400);
    assert.equal((await post(component({ credit: id }))).status, 400);
    assert.equal((await post({ ...input, user_id: id })).status, 400);
  }
  for (const body of [null, [], {}, { entries: [share] }, { ...input, group_id: "2" }, { ...input, type: "PAYMENT" },
    { ...input, amount: "500.00" }, { ...input, cycle_id: "bad" },
    ...[undefined, null, {}, [], Array(101).fill(share), [null], ["BUY_SHARE"]].map(entries => ({ ...input, entries })),
    component({ type: "EQUITY" }), component({ type: "INTEREST_PAYMENT" }), component({ type: undefined }),
    component({ debit: "106" }), component({ user_id: "12" }), component({ amount: undefined }),
    ...["\u0000", "x".repeat(4001), 1, {}].flatMap(description => [{ ...input, description }, component({ description })]),
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post(input, {}, '{"user_id":"11","entries":[')).status, 400);
  assert.equal(state.writes.length, 0);
});

test("payments POST authenticates and scopes financial writers to header group", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, { authorization: "" })).status, 401);
  assert.equal((await post(input, { "x-group-slug": "" })).status, 400);
  assert.equal((await post(input, { "x-group-slug": "beta" })).status, 403);
  for (const role of ["MEMBER", "AUDITOR", null, "owner"]) {
    state.role = role;
    assert.equal((await post(input)).status, 403);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.queries.some(q => q.sql.includes('from "accounts"')), false);
});

test("payments POST enforces component accounting roles", async t => {
  const { state, post } = fixture(t);
  state.accounts[0].type = "INCOME";
  assert.equal((await post(input)).status, 400);
  state.accounts[0].type = "ASSET";
  for (const changes of [
    { credit: "102" }, { type: "LOAN_PAYMENT", credit: "106" },
    { type: "LOAN_PAYMENT", credit: "107" }, { type: "PENALTY_PAYMENT", credit: "102" },
    { type: "PENALTY_PAYMENT", credit: "106" },
    { type: "PAY_CONTRIBUTION", credit: "102" },
  ]) assert.equal((await post(component(changes))).status, 400);
  state.accounts[1].type = "INCOME";
  assert.equal((await post(component({ type: "LOAN_PAYMENT", credit: "102" }))).status, 400);
  state.accounts[3].type = "INCOME";
  assert.equal((await post(component({ type: "PENALTY_PAYMENT", credit: "107" }))).status, 400);
  state.accounts[4].type = "ASSET";
  assert.equal((await post(component({ type: "PENALTY_PAYMENT", credit: "108" }))).status, 400);
  state.accounts[5].type = "INCOME";
  assert.equal((await post(component({ type: "PAY_CONTRIBUTION", credit: "109" }))).status, 400);
  assert.equal(state.writes.length, 0);
});

test("payments POST enforces a shared cycle and group member cycle membership", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post({ ...input, cycle_id: "99" })).status, 400);
  state.accounts[2].cycle_id = "99";
  assert.equal((await post(input)).status, 400);
  state.accounts[2].cycle_id = "20";
  state.member = false;
  assert.equal((await post(input)).status, 404);
  state.member = true; state.membership = false;
  assert.equal((await post(input)).status, 400);
  state.membership = true;
  state.accounts.forEach(a => { a.cycle_id = null; });
  assert.equal((await post(input)).status, 400);
  assert.equal((await post({ ...input, cycle_id: "20" })).status, 201);
  state.cycle = false;
  assert.equal((await post({ ...input, cycle_id: "20" })).status, 404);
  state.accounts = [];
  assert.equal((await post(input)).status, 404);
});

test("payments POST waits for commit, rolls back and sanitizes constraint/server errors", async t => {
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
  assert.equal(state.writes.length, 0);
  assert.equal(result.body.error, "Internal server error");
});

test("the replaced equity POST route returns 404", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(input, {}, undefined, "/api/v1/transactions/equity")).status, 404);
  assert.equal(state.writes.length, 0);
});

test("donations POST records a balanced donation without a frontend date", async t => {
  const { state, post } = fixture(t);
  const result = await post({
    debit: "110",
    credit: "111",
    amount: "1250.05",
    remarks: "Community donation",
  }, {}, undefined, "/api/v1/transactions/donations");

  assert.equal(result.status, 201);
  assert.equal(result.body.transaction.type, "DONATION");
  assert.equal(result.body.transaction.amount, "1250.05");
  assert.equal(result.body.transaction.cycle_id, "20");
  assert.equal(result.body.transaction.user_id, null);
  assert.equal(result.body.transaction.description, "Community donation");
  assert.equal(result.body.transaction.occurred_at, "2026-10-03T08:12:34.567Z");
  assert.ok(!Object.hasOwn(state.writes[0].rows[0], "occurred_at"));
  assert.doesNotMatch(state.queries.find(query => query.sql.startsWith('insert into "transactions"')).sql, /occurred_at/);
  assert.equal(result.body.entries.length, 1);
  assert.equal(result.body.entries[0].amount, "1250.05");
  assert.equal(result.body.entries[0].description, "Community donation");
  assert.deepEqual(result.body.account_entries.map(({ account_id, amount }) => [account_id, amount]), [
    ["110", "1250.05"], ["111", "-1250.05"],
  ]);
  assert.match(state.queries.find(query => query.sql.includes('from "cycles"')).sql, /for update/);
});

test("donations POST validates aliases, amounts, IDs and account rules before writing", async t => {
  const { state, post } = fixture(t);
  const path = "/api/v1/transactions/donations";
  const donation = { debit: "110", credit: "111", amount: "10.00", date: "2026-10-03" };
  for (const changes of [
    { amount: 0 }, { amount: "0.00" }, { amount: "-1.00" }, { amount: "1.001" },
    { amount: "10000000000000000.00" },
    { debit: "bad" }, { credit: "9223372036854775808" },
    { description: "one", remarks: "two" }, { extra: true },
  ]) {
    assert.equal((await post({ ...donation, ...changes }, {}, undefined, path)).status, 400);
  }
  assert.equal((await post({ ...donation, description: "same", remarks: "same" }, {}, undefined, path)).status, 201);
  assert.equal(state.writes.length, 3);

  state.writes.length = 0;
  for (const changes of [
    { debit: "111" }, { credit: "110" }, { credit: "108" }, { debit: "999" },
  ]) {
    assert.ok([400, 404].includes((await post({ ...donation, ...changes }, {}, undefined, path)).status));
  }
  state.accounts.push({ id: "112", cycle_id: "99", type: "ASSET", code: "1000" });
  assert.equal((await post({ ...donation, debit: "112" }, {}, undefined, path)).status, 400);
  assert.equal(state.writes.length, 0);
});

test("donations POST requires a writable cycle and an authorized financial writer", async t => {
  const { state, post } = fixture(t);
  const path = "/api/v1/transactions/donations";
  const donation = { debit: "110", credit: "111", amount: "10.00", date: "2026-10-03" };
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    state.cycleStatus = role === "TREASURER" ? "distributing" : "active";
    assert.equal((await post(donation, {}, undefined, path)).status, 201);
  }
  state.writes.length = 0;
  for (const role of ["MEMBER", "AUDITOR", null, "owner"]) {
    state.role = role;
    assert.equal((await post(donation, {}, undefined, path)).status, 403);
  }
  state.role = "OWNER";
  for (const status of ["draft", "closed"]) {
    state.cycleStatus = status;
    assert.equal((await post(donation, {}, undefined, path)).status, 409);
  }
  state.cycle = false;
  assert.equal((await post(donation, {}, undefined, path)).status, 409);
  assert.equal((await post(donation, { authorization: "" }, undefined, path)).status, 401);
  assert.equal(state.writes.length, 0);
});

test("donations POST rolls back and maps ledger persistence conflicts", async t => {
  const { state, post } = fixture(t);
  const path = "/api/v1/transactions/donations";
  const donation = { debit: "110", credit: "111", amount: "10.00", date: "2026-10-03" };
  for (const code of ["23503", "23514", "40001", "40P01"]) {
    state.error = Object.assign(new Error("private error"), { code });
    const result = await post(donation, {}, undefined, path);
    assert.equal(result.status, 409);
    assert.equal(state.writes.length, 0);
    assert.doesNotMatch(result.body.error, /private/);
  }
});


test("donations POST ignores legacy dates and leaves timestamp assignment to the database", async t => {
  const { state, post } = fixture(t);
  for (const date of ["2000-01-01", "2099-12-31", "2026-02-30", "", null]) {
    const result = await post({ debit: "110", credit: "111", amount: "10.00", date }, {}, undefined, "/api/v1/transactions/donations");
    assert.equal(result.status, 201);
    assert.equal(result.body.transaction.occurred_at, "2026-10-03T08:12:34.567Z");
  }
  for (const write of state.writes.filter(write => write.table === "transactions")) {
    assert.ok(!Object.hasOwn(write.rows[0], "occurred_at"));
  }
});


const expensePath = "/api/v1/transactions/add-expense";
const expense = { debit: "120", credit: "121", amount: 2000, description: "Monthly system subscription" };

test("add-expense creates an unpaid expense with equal expense/payable postings and server time", async t => {
  const { state, post } = fixture(t);
  const result = await post(expense, {}, undefined, expensePath);
  assert.equal(result.status, 201);
  assert.equal(result.body.transaction.type, "EXPENSE");
  assert.equal(result.body.transaction.amount, "2000.00");
  assert.equal(result.body.transaction.description, expense.description);
  assert.equal(result.body.transaction.group_id, "1");
  assert.equal(result.body.transaction.cycle_id, "20");
  assert.equal(result.body.transaction.user_id, null);
  assert.equal(result.body.transaction.occurred_at, "2026-10-03T08:12:34.567Z");
  assert.equal(result.body.entries.length, 1);
  const entry = result.body.entries[0];
  assert.equal(entry.type, "EXPENSE");
  assert.equal(entry.amount, "2000.00");
  assert.equal(entry.description, expense.description);
  assert.equal(entry.transaction_id, result.body.transaction.id);
  assert.equal(entry.group_id, "1");
  assert.equal(entry.cycle_id, "20");
  assert.equal(entry.user_id, null);
  assert.deepEqual(result.body.account_entries.map(p => [p.account_id, p.amount]), [["120", "2000.00"], ["121", "-2000.00"]]);
  assert.ok(result.body.account_entries.every(p => p.transaction_entry_id === entry.id && p.group_id === "1"));
  assert.deepEqual(state.writes.map(w => w.table), ["transactions", "transaction_entries", "account_entries"]);
  assert.ok(!Object.hasOwn(state.writes[0].rows[0], "occurred_at"));
  assert.match(state.queries.find(q => q.sql.includes('from "cycles"')).sql, /order by "created_at" desc, "id" desc.*for update/);
  assert.equal((await post({ ...expense, amount: "9999999999999999.99" }, {}, undefined, expensePath)).body.transaction.amount, "9999999999999999.99");
});

test("add-expense validates money, required description, IDs and unsupported fields before writes", async t => {
  const { state, post } = fixture(t);
  for (const amount of [undefined, null, 0, -1, "0.00", "1.001", "NaN", "Infinity", "1e3", true, {}, "10000000000000000.00", 1000000000001]) {
    assert.equal((await post({ ...expense, amount }, {}, undefined, expensePath)).status, 400);
  }
  for (const description of [undefined, null, "", "  ", "\n\t", 42, {}, "bad\0text", "x".repeat(4001)]) {
    assert.equal((await post({ ...expense, description }, {}, undefined, expensePath)).status, 400);
  }
  for (const changes of [{ debit: "bad" }, { credit: "9223372036854775808" }, { debit: "121" }, { credit: 1.5 }, { date: "2026-10-03" }, { user_id: "11" }, { cycle_id: "20" }, { remarks: "alias" }]) {
    assert.equal((await post({ ...expense, ...changes }, {}, undefined, expensePath)).status, 400);
  }
  assert.equal(state.writes.length, 0);
});

test("add-expense rejects wrong types, foreign groups and foreign or unscoped cycles", async t => {
  const { state, post } = fixture(t);
  for (const side of ["debit", "credit"]) {
    for (const type of ["ASSET", "INCOME", "EQUITY", side === "debit" ? "LIABILITY" : "EXPENSE"]) {
      state.accounts.push({ id: "130", cycle_id: "20", type, code: "9999" });
      assert.equal((await post({ ...expense, [side]: "130" }, {}, undefined, expensePath)).status, 400);
      state.accounts.pop();
    }
    for (const cycle_id of ["99", null]) {
      state.accounts.push({ id: "130", cycle_id, type: side === "debit" ? "EXPENSE" : "LIABILITY" });
      assert.equal((await post({ ...expense, [side]: "130" }, {}, undefined, expensePath)).status, 400);
      state.accounts.pop();
    }
    state.accounts.push({ id: "130", group_id: "2", cycle_id: "20", type: side === "debit" ? "EXPENSE" : "LIABILITY" });
    assert.equal((await post({ ...expense, [side]: "130" }, {}, undefined, expensePath)).status, 404);
    assert.equal((await post({ ...expense, [side]: "999" }, {}, undefined, expensePath)).status, 404);
    state.accounts.pop();
  }
  assert.equal(state.writes.length, 0);
  state.accounts.push({ id: "130", cycle_id: "20", type: "LIABILITY", code: "2100" });
  assert.equal((await post({ ...expense, credit: "130" }, {}, undefined, expensePath)).status, 201);
});

test("add-expense requires authenticated scoped writers and a writable cycle", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN", "TREASURER"]) {
    state.role = role;
    for (const cycleStatus of ["active", "distributing"]) {
      state.cycleStatus = cycleStatus;
      assert.equal((await post(expense, {}, undefined, expensePath)).status, 201);
    }
  }
  state.writes.length = 0;
  for (const role of ["MEMBER", "SECRETARY", "AUDITOR"]) {
    state.role = role;
    assert.equal((await post(expense, {}, undefined, expensePath)).status, 403);
  }
  state.role = "OWNER";
  assert.equal((await post(expense, { authorization: "" }, undefined, expensePath)).status, 401);
  assert.equal((await post(expense, { "x-group-slug": "beta" }, undefined, expensePath)).status, 403);
  for (const cycleStatus of ["draft", "closed"]) {
    state.cycleStatus = cycleStatus;
    assert.equal((await post(expense, {}, undefined, expensePath)).status, 409);
  }
  state.cycle = false;
  assert.equal((await post(expense, {}, undefined, expensePath)).status, 409);
  assert.equal(state.writes.length, 0);
});

test("add-expense rolls back failures at every write and at commit, sanitizing errors", async t => {
  const { state, post } = fixture(t);
  for (const table of ["transactions", "transaction_entries", "account_entries"]) {
    state.failTable = table;
    state.writeError = Object.assign(new Error("private details"), { code: "23514" });
    const result = await post(expense, {}, undefined, expensePath);
    assert.equal(result.status, 409);
    assert.doesNotMatch(result.body.error, /private/);
    assert.equal(state.writes.length, 0);
  }
  state.failTable = null;
  for (const code of ["23001", "23503", "23505", "23514", "40001", "40P01", "unexpected"]) {
    state.error = Object.assign(new Error("private details"), { code });
    const result = await post(expense, {}, undefined, expensePath);
    assert.equal(result.status, code === "unexpected" ? 500 : 409);
    assert.doesNotMatch(result.body.error, /private/);
    assert.equal(state.writes.length, 0);
  }
});
