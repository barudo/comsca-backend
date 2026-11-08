const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const knex = require('knex');
const serverless = require('serverless-http');
const { createApp } = require('../src/app');
const { assertCycleTransactionsUnfrozen, transitionCycleFreeze, FROZEN_MESSAGE } = require('../dist/services/cycle-freeze');
const migration = require('../migrations/042_cycle_transaction_freeze');

// Only use a disposable local instance: each run creates and drops its own database.
test('cycle freeze PostgreSQL integration', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
  const name = `freeze_${process.pid}_${Date.now()}`;
  let db;
  t.after(async () => {
    try { if (db) await db.destroy(); await admin.raw('DROP DATABASE IF EXISTS ??', [name]); }
    finally { await admin.destroy(); }
  });
  await admin.raw('CREATE DATABASE ??', [name]);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 8 } });
  const root = path.join(__dirname, '../migrations');
  for (const file of fs.readdirSync(root).sort()) {
    const n = Number(file.slice(0, 3));
    // Supabase auth triggers require its managed auth schema; use trusted test identities instead.
    if ([3, 4, 8, 9].includes(n) || n >= 42) continue;
    await db.transaction(trx => require(path.join(root, file)).up(trx));
    if (n === 1) await db.raw("ALTER TABLE users ADD COLUMN auth_user_id text, ADD COLUMN role text DEFAULT 'OWNER'");
  }
  let seq = 0;
  async function fixture() {
    seq++;
    const [group] = await db('groups').insert({ name: `Freeze ${seq}`, slug: `freeze-${seq}` }).returning('*');
    const users = await db('users').insert(['OWNER', 'ADMIN', 'TREASURER', 'AUDITOR', 'MEMBER'].map(role => ({
      group_id: group.id, username: `${seq}-${role}`, first_name: role, family_name: 'Tester',
      email: `${seq}-${role}@example.test`, password: 'unused', auth_user_id: `${seq}-${role}`, role,
    }))).returning('*');
    const [cycle] = await db('cycles').insert({ group_id: group.id, status: 'active', interest_rate: '0.01',
      interest_period: 'MONTHLY', interest_method: 'SIMPLE' }).returning('*');
    await db('cycle_members').insert(users.map(user => ({ cycle_id: cycle.id, user_id: user.id })));
    const accounts = Object.fromEntries((await db('accounts').where({ cycle_id: cycle.id })).map(a => [a.code, a.id]));
    const app = serverless(createApp(db, { getUser: async ({ access_token }) => ({ id: access_token, user_metadata: { role: 'OWNER' } }) }));
    async function call(method, route, body, actor = users[0], slug = group.slug) {
      const response = await app({ version: '2.0', rawPath: route, rawQueryString: '',
        headers: { authorization: `Bearer ${actor.auth_user_id}`, 'content-type': 'application/json', 'x-group-slug': slug },
        requestContext: { http: { method, sourceIp: '127.0.0.1' } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, {});
      return { status: response.statusCode, body: JSON.parse(response.body) };
    }
    const scope = { groupId: group.id, cycleId: cycle.id, authUserId: users[0].auth_user_id };
    const change = frozen => db.transaction(trx => transitionCycleFreeze(trx, { ...scope, frozen }));
    const endpoint = action => `/api/v1/cycles/${cycle.id}/${action}`;
    return { group, users, cycle, accounts, call, scope, change, endpoint };
  }
  async function post(trx, f) {
    const [header] = await trx('transactions').insert({ group_id: f.group.id, cycle_id: f.cycle.id,
      user_id: f.cycle.id === null ? null : f.users[0].id, type: 'BUY_SHARE', amount: '10.00' }).returning('*');
    const [entry] = await trx('transaction_entries').insert({ group_id: f.group.id, cycle_id: f.cycle.id,
      transaction_id: header.id, user_id: f.cycle.id === null ? null : f.users[0].id, type: 'BUY_SHARE', amount: '10.00',
      debit: f.accounts['1000'], credit: f.accounts['3000'] }).returning('*');
    await trx('account_entries').insert([
      { group_id: f.group.id, transaction_entry_id: entry.id, account_id: f.accounts['1000'], amount: '10.00' },
      { group_id: f.group.id, transaction_entry_id: entry.id, account_id: f.accounts['3000'], amount: '-10.00' },
    ]);
    return header;
  }
  const ledger = async () => Object.fromEntries(await Promise.all(['transactions', 'transaction_entries', 'account_entries'].map(async table => [table, await db(table).orderBy('id')])));
  const before = await fixture();
  await db.transaction(trx => post(trx, before));
  const originalLedger = await ledger();
  const originalPolicies = (await db.raw("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  await db.transaction(trx => migration.up(trx));

  await t.test('migration freezes existing and new cycles without changing ledger, lifecycle or policies', async () => {
    assert.deepEqual(await ledger(), originalLedger);
    const existing = await db('cycles').where({ id: before.cycle.id }).first();
    assert.equal(existing.transactions_frozen, true);
    assert.equal(existing.status, 'active');
    assert.equal(existing.transactions_frozen_at, null);
    const fresh = await fixture();
    assert.equal(fresh.cycle.transactions_frozen, true);
    const policies = (await db.raw("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename<>'cycle_freeze_logs' ORDER BY tablename,policyname")).rows;
    assert.deepEqual(policies, originalPolicies);
    const other = await fixture();
    await db('cycles').where({ id: other.cycle.id }).update({ status: 'closed' });
    const created = await other.call('POST', '/api/v1/cycles', { name: 'New cycle' });
    assert.equal(created.status, 201);
    assert.equal((await db('cycles').where({ id: created.body.cycle.id }).first()).transactions_frozen, true);
    const listed = await other.call('GET', '/api/v1/cycles');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.cycles[0].transactions_frozen, true);
  });

  await t.test('owner/admin transitions, retries, audit identities and group isolation', async () => {
    const f = await fixture(), foreign = await fixture();
    for (const actor of f.users.slice(0, 2)) {
      const unfrozen = await f.call('PATCH', f.endpoint('unfreeze'), { reason: 'Meeting' }, actor);
      assert.equal(unfrozen.status, 200);
      assert.equal(unfrozen.body.data.transactionsFrozen, false);
      assert.equal(unfrozen.body.data.unfrozenBy.id, actor.id);
      const saved = await db('cycles').where({ id: f.cycle.id }).first();
      assert.deepEqual(await f.call('PATCH', f.endpoint('unfreeze'), undefined, actor), unfrozen);
      assert.deepEqual(await db('cycles').where({ id: f.cycle.id }).first(), saved);
      const frozen = await f.call('PATCH', f.endpoint('freeze'), undefined, actor);
      assert.equal(frozen.status, 200);
      assert.deepEqual(await f.call('PATCH', f.endpoint('freeze'), undefined, actor), frozen);
      assert.equal(frozen.body.data.frozenBy.id, actor.id);
    }
    const logs = await db('cycle_freeze_logs').where({ cycle_id: f.cycle.id }).orderBy('id');
    assert.deepEqual(logs.map(row => row.action), ['UNFREEZE', 'FREEZE', 'UNFREEZE', 'FREEZE']);
    assert.equal(logs[0].reason, 'Meeting');
    assert.equal(logs[0].previous_state, true); assert.equal(logs[0].new_state, false);
    assert.equal((await f.call('PATCH', f.endpoint('unfreeze'), undefined, foreign.users[0])).status, 403);
    assert.equal((await f.call('PATCH', f.endpoint('unfreeze'), undefined, foreign.users[0], foreign.group.slug)).status, 404);
    for (const actor of f.users.slice(2)) {
      assert.equal((await f.call('PATCH', f.endpoint('freeze'), undefined, actor)).status, 403);
      assert.equal((await f.call('PATCH', f.endpoint('unfreeze'), undefined, actor)).status, 403);
      const status = await f.call('GET', f.endpoint('freeze-status'), undefined, actor);
      assert.equal(status.status, 200); assert.equal(status.body.data.canManageFreeze, false);
    }
    for (const status of ['draft', 'distributing', 'closed']) {
      const f2 = await fixture();
      await db('cycles').where({ id: f2.cycle.id }).update({ status });
      assert.equal((await f2.call('PATCH', f2.endpoint('unfreeze'))).status, 409);
    }
  });

  await t.test('all financial API paths reject while frozen, including batch payments, journals and voids', async () => {
    const f = await fixture();
    await f.change(false);
    const payment = { user_id: f.users[4].id, entries: [{ type: 'BUY_SHARE', debit: f.accounts['1000'], credit: f.accounts['3000'], amount: '10.00' }] };
    const receipt = await f.call('POST', '/api/v1/transactions/payments', payment);
    assert.equal(receipt.status, 201, JSON.stringify(receipt));
    const expenseBody = { debit: f.accounts['5000'], credit: f.accounts['2000'], amount: '1.00', description: 'Supplies' };
    const expense = await f.call('POST', '/api/v1/transactions/add-expense', expenseBody);
    assert.equal(expense.status, 201, JSON.stringify(expense));
    const loanBody = { user_id: f.users[4].id, debit: f.accounts['1100'], credit: f.accounts['1000'], amount: '1.00' };
    const loan = await f.call('POST', '/api/v1/transactions/disburse-loans', loanBody);
    assert.equal(loan.status, 201, JSON.stringify(loan));
    await f.change(true);
    const snapshot = await ledger();
    const counters = await db('cycles').where({ id: f.cycle.id }).first();
    const writes = [
      ['POST', '/api/v1/transactions/payments', payment],
      ...[['LOAN_PAYMENT', '1100'], ['PAY_CONTRIBUTION', '1400'], ['PENALTY_PAYMENT', '1300']].map(([type, code]) => ['POST', '/api/v1/transactions/payments', { ...payment, entries: [{ ...payment.entries[0], type, credit: f.accounts[code] }] }]),
      ['POST', '/api/v1/transactions/donations', { debit: f.accounts['1000'], credit: f.accounts['4300'], amount: '1.00' }],
      ['POST', '/api/v1/transactions/add-expense', expenseBody],
      ['POST', '/api/v1/transactions/disburse-loans', loanBody],
      ['POST', '/api/v1/transactions/expenses/pay', { debit: f.accounts['2000'], credit: f.accounts['1000'], expenses: [{ id: expense.body.transaction.id, amount: '1.00' }] }],
      ['POST', '/api/v1/contributions/charge', { debit: f.accounts['1400'], credit: f.accounts['4400'], amount: '1.00' }],
      ['POST', '/api/v1/penalties/charge', { user_id: f.users[4].id, debit: f.accounts['1300'], credit: f.accounts['4100'], amount: '1.00' }],
      ['POST', '/api/v1/interests/charge', { debit: f.accounts['1100'], credit: f.accounts['4000'] }],
      ...[receipt, expense, loan].map(result => ['DELETE', `/api/v1/transactions/${result.body.transaction.id}`]),
    ];
    for (const [method, route, body] of writes) {
      const result = await f.call(method, route, body);
      assert.deepEqual(result, { status: 423, body: { success: false, error: { code: 'TRANSACTIONS_FROZEN', message: FROZEN_MESSAGE } } }, route);
    }
    assert.deepEqual(await ledger(), snapshot);
    assert.deepEqual(await db('cycles').where({ id: f.cycle.id }).first(), counters);
    // Business handler invocation without Express still enforces the service guard.
    const request = { app: { locals: { database: db } }, group: f.group, authUser: { id: f.users[0].auth_user_id }, body: payment };
    const response = { status() { return this; }, json() { assert.fail('Frozen internal posting must not succeed'); } };
    await assert.rejects(new (require('../src/handlers/payment-transactions'))().create(request, response, error => { throw error; }), { code: 'TRANSACTIONS_FROZEN' });
    await f.change(false);
    const paid = await f.call('POST', '/api/v1/transactions/expenses/pay', writes[7][2]);
    assert.equal(paid.status, 201, JSON.stringify(paid));
    assert.equal((await db('transactions').where({ id: expense.body.transaction.id }).first()).expense_payment_status, 'PAID');
    assert.equal((await f.call('DELETE', `/api/v1/transactions/${receipt.body.transaction.id}`)).status, 200);
  });

  await t.test('frozen reports, member accounts and cycle listing remain readable', async () => {
    const f = before;
    for (const route of ['/api/v1/accounting/trial-balance', '/api/v1/accounting/balance-sheet', '/api/v1/accounting/income-statement', '/api/v1/me/transactions', '/api/v1/cycles']) {
      const result = await f.call('GET', route, undefined, f.users[4]);
      assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`);
      if (route === '/api/v1/cycles') assert.equal(result.body.cycles[0].transactions_frozen, true);
    }
    assert.equal((await f.call('GET', '/api/v1/cycles/members')).status, 200);
    assert.equal((await f.call('GET', '/api/v1/transactions/registers')).status, 200);
    assert.equal((await f.call('GET', `/api/v1/transactions/${originalLedger.transactions[0].id}/entries`)).status, 200);
  });

  await t.test('legacy void is blocked without a cycle and failed postings/audit leave no partial records', async () => {
    const f = await fixture();
    const legacyAccounts = await db('accounts').insert([
      { group_id: f.group.id, code: '1000', name: 'Legacy cash', type: 'ASSET' },
      { group_id: f.group.id, code: '3000', name: 'Legacy equity', type: 'EQUITY' },
    ]).returning('*');
    const legacy = await db.transaction(trx => post(trx, { ...f, cycle: { id: null }, accounts: Object.fromEntries(legacyAccounts.map(a => [a.code, a.id])) }));
    assert.equal((await f.call('DELETE', `/api/v1/transactions/${legacy.id}`)).status, 409);
    assert.deepEqual(await db('transactions').where({ id: legacy.id }).first(), legacy);
    await f.change(false);
    const snapshot = await ledger();
    await assert.rejects(db.transaction(async trx => {
      await assertCycleTransactionsUnfrozen(f.cycle.id, trx, { groupId: f.group.id });
      await post(trx, f);
      throw new Error('failure after posting');
    }), /failure after posting/);
    assert.deepEqual(await ledger(), snapshot);
    await assert.rejects(db.transaction(async trx => {
      await transitionCycleFreeze(trx, { ...f.scope, frozen: true });
      throw new Error('failure before commit');
    }), /failure before commit/);
    assert.equal((await db('cycles').where({ id: f.cycle.id }).first()).transactions_frozen, false);
    assert.equal((await db('cycle_freeze_logs').where({ cycle_id: f.cycle.id })).length, 1);
    await assert.rejects(db.transaction(trx => migration.down(trx)), /lose freeze audit records/);
  });

  await t.test('cycle and audit RLS preserve group isolation and deny audit mutation', async () => {
    const f = await fixture(), foreign = await fixture();
    await f.change(false); await foreign.change(false);
    await db.transaction(async trx => {
      await trx.raw('SET LOCAL ROLE comsca_group_reader');
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [f.group.id]);
      assert.deepEqual((await trx('cycles').select('id', 'transactions_frozen')).map(c => c.id), [f.cycle.id]);
      assert.ok((await trx('cycle_freeze_logs')).every(row => row.group_id === f.group.id));
      assert.equal((await trx('cycle_freeze_logs').where({ cycle_id: foreign.cycle.id })).length, 0);
    });
    for (const operation of ['update', 'delete']) await assert.rejects(db.transaction(async trx => {
      await trx.raw('SET LOCAL ROLE comsca_group_reader');
      await trx.raw("SELECT set_config('app.group_id', ?, true)", [f.group.id]);
      if (operation === 'update') await trx('cycle_freeze_logs').update({ reason: 'tampered' });
      else await trx('cycle_freeze_logs').del();
    }), { code: '42501' });
    await assert.rejects(db.transaction(trx => assertCycleTransactionsUnfrozen(foreign.cycle.id, trx, { groupId: f.group.id })), { status: 404 });
  });

  async function waitForBlock(pid) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.raw('SELECT cardinality(pg_blocking_pids(?)) AS blocked', [pid]);
      if (rows[0].blocked > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Expected real PostgreSQL lock contention');
  }
  await t.test('freeze waits for a posting commit or rollback, then subsequent postings reject', async () => {
    for (const rollback of [false, true]) {
      const f = await fixture(); await f.change(false);
      const posting = await db.transaction(), freezing = await db.transaction();
      try {
        await assertCycleTransactionsUnfrozen(f.cycle.id, posting, { groupId: f.group.id });
        const header = await post(posting, f);
        const { rows } = await freezing.raw('SELECT pg_backend_pid() AS pid');
        const pending = transitionCycleFreeze(freezing, { ...f.scope, frozen: true });
        await waitForBlock(rows[0].pid);
        if (rollback) await posting.rollback(); else await posting.commit();
        assert.equal((await pending).transactionsFrozen, true);
        await freezing.commit();
        assert.equal(Boolean(await db('transactions').where({ id: header.id }).first()), !rollback);
        await assert.rejects(db.transaction(trx => assertCycleTransactionsUnfrozen(f.cycle.id, trx, { groupId: f.group.id })), { code: 'TRANSACTIONS_FROZEN' });
      } finally { await posting.rollback(); await freezing.rollback(); }
    }
  });
  await t.test('posting waiting behind freeze observes committed frozen state and cannot write', async () => {
    const f = await fixture(); await f.change(false);
    const freezing = await db.transaction(), posting = await db.transaction();
    try {
      await transitionCycleFreeze(freezing, { ...f.scope, frozen: true });
      const { rows } = await posting.raw('SELECT pg_backend_pid() AS pid');
      const pending = assertCycleTransactionsUnfrozen(f.cycle.id, posting, { groupId: f.group.id });
      const rejected = assert.rejects(pending, { code: 'TRANSACTIONS_FROZEN' });
      await waitForBlock(rows[0].pid);
      await freezing.commit();
      await rejected; await posting.rollback();
      assert.equal((await db('transactions').where({ cycle_id: f.cycle.id })).length, 0);
    } finally { await freezing.rollback(); await posting.rollback(); }
  });
});
