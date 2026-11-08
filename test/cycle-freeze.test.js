const { test } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const serverless = require('serverless-http');
const { createApp } = require('../src/app');
const { assertCycleTransactionsUnfrozen, validateCycleId, validateReason, FROZEN_MESSAGE } = require('../dist/services/cycle-freeze');

function fixture(t) {
  const db = knex({ client: 'pg' });
  t.after(() => db.destroy());
  db.isTransaction = true;
  const state = { role: 'OWNER', logs: [], queries: [], cycle: {
    id: '20', group_id: '1', status: 'active', transactions_frozen: true,
    transactions_frozen_at: null, transactions_frozen_by: null,
    transactions_unfrozen_at: null, transactions_unfrozen_by: null,
  } };
  Object.defineProperty(db, 'transaction', { value: async fn => {
    const before = structuredClone({ cycle: state.cycle, logs: state.logs });
    try { return await fn(db); } catch (e) { Object.assign(state, before); throw e; }
  } });
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); state.queries.push(q);
    const table = builder._single?.table;
    if (q.sql.includes('from "groups"')) return { id: q.bindings[0] === 'alpha' ? '1' : '2' };
    if (q.sql.includes('from "users"')) {
      if (q.sql.includes('"auth_user_id"')) {
        assert.match(q.sql, /for share$/);
        return q.bindings[0] === '1' && state.role ? { id: '10', role: state.role } : undefined;
      }
      return [{ id: '10', first_name: 'Juan', family_name: 'Dela Cruz' }];
    }
    if (q.sql.includes('from "cycles"')) return q.bindings[0] === '20' && q.bindings[1] === '1' ? { ...state.cycle } : undefined;
    if (q.method === 'update' && table === 'cycles') {
      const changes = builder._single.update;
      for (const [key, value] of Object.entries(changes)) state.cycle[key] = value?.toSQL ? '2026-11-09T00:00:00.000Z' : value;
      return [{ ...state.cycle }];
    }
    if (q.method === 'insert' && table === 'cycle_freeze_logs') {
      if (state.auditFailure) throw new Error('audit unavailable');
      state.logs.push(builder._single.insert); return [];
    }
    throw new Error(`Unexpected query: ${q.sql}`);
  } });
  const handler = serverless(createApp(db, { getUser: async () => ({ id: 'auth', user_metadata: { role: 'OWNER' } }) }));
  async function call(action, { body, id = '20', headers = {} } = {}) {
    const result = await handler({ version: '2.0', rawPath: `/api/v1/cycles/${id}/${action}`, rawQueryString: '',
      headers: { authorization: 'Bearer token', 'x-group-slug': 'alpha', 'content-type': 'application/json', ...headers },
      requestContext: { http: { method: action === 'freeze-status' ? 'GET' : 'PATCH', sourceIp: '127.0.0.1' } },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, {});
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }
  return { db, state, call };
}

test('freeze API permits scoped OWNER/ADMIN, preserves metadata on retries and audits transitions', async t => {
  const { state, call } = fixture(t);
  for (const role of ['OWNER', 'ADMIN']) {
    state.role = role;
    const unfrozen = await call('unfreeze', { body: { reason: 'Meeting started' } });
    assert.equal(unfrozen.status, 200);
    assert.equal(unfrozen.body.data.transactionsFrozen, false);
    assert.equal(unfrozen.body.data.canManageFreeze, true);
    assert.deepEqual(unfrozen.body.data.unfrozenBy, { id: '10', name: 'Juan Dela Cruz' });
    const count = state.logs.length;
    assert.deepEqual(await call('unfreeze'), unfrozen);
    assert.equal(state.logs.length, count);
    const frozen = await call('freeze');
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.data.transactionsFrozen, true);
    assert.deepEqual(await call('freeze'), frozen);
    assert.equal(state.logs.length, count + 1);
  }
  assert.deepEqual(state.logs.map(row => row.action), ['UNFREEZE', 'FREEZE', 'UNFREEZE', 'FREEZE']);
  assert.equal(state.logs[0].reason, 'Meeting started');
  assert.ok(state.queries.some(q => q.sql.includes('from "cycles"') && /for update$/.test(q.sql)));
});

test('officers and members can read freeze status but cannot manage it, regardless of token metadata', async t => {
  const { state, call } = fixture(t);
  for (const role of ['TREASURER', 'AUDITOR', 'MEMBER']) {
    state.role = role;
    assert.equal((await call('freeze')).status, 403);
    assert.equal((await call('unfreeze')).status, 403);
    const result = await call('freeze-status');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.canManageFreeze, false);
  }
  assert.equal(state.logs.length, 0);
});

test('freeze API rejects missing authentication, outsiders, foreign cycles, malformed IDs and body fields', async t => {
  const { call } = fixture(t);
  assert.equal((await call('freeze', { headers: { authorization: '' } })).status, 401);
  assert.equal((await call('freeze', { headers: { 'x-group-slug': 'beta' } })).status, 403);
  assert.equal((await call('freeze', { id: '21' })).status, 404);
  assert.equal((await call('freeze-status', { id: '21' })).status, 404);
  for (const id of ['0', '-1', '01', 'abc', '9223372036854775808']) assert.equal((await call('freeze', { id })).status, 400);
  for (const body of [{ role: 'ADMIN' }, [], { reason: 2 }, { reason: 'x'.repeat(4001) }]) assert.equal((await call('freeze', { body })).status, 400);
});

test('draft, distributing and closed cycles cannot unfreeze, including retries', async t => {
  const { state, call } = fixture(t);
  for (const status of ['draft', 'distributing', 'closed']) {
    state.cycle.status = status;
    for (const frozen of [false, true]) {
      state.cycle.transactions_frozen = frozen;
      assert.equal((await call('unfreeze')).status, 409);
    }
  }
  assert.equal(state.logs.length, 0);
});

test('audit failure rolls back freeze state', async t => {
  const { state, call } = fixture(t);
  state.auditFailure = true;
  assert.equal((await call('unfreeze')).status, 500);
  assert.equal(state.cycle.transactions_frozen, true);
  assert.equal(state.cycle.transactions_unfrozen_at, null);
  assert.equal(state.logs.length, 0);
});

test('reusable posting guard fails closed and requires a transaction, group scope and active cycle', async t => {
  const { db, state } = fixture(t);
  await assert.rejects(assertCycleTransactionsUnfrozen('20', db, { groupId: '1' }), { status: 423, code: 'TRANSACTIONS_FROZEN', message: FROZEN_MESSAGE });
  await assert.rejects(assertCycleTransactionsUnfrozen(null, db, { groupId: '1' }), { status: 409 });
  await assert.rejects(assertCycleTransactionsUnfrozen('20', db, { groupId: '2' }), { status: 404 });
  state.cycle.transactions_frozen = false;
  assert.equal((await assertCycleTransactionsUnfrozen('20', db, { groupId: '1' })).id, '20');
  state.cycle.status = 'closed';
  await assert.rejects(assertCycleTransactionsUnfrozen('20', db, { groupId: '1' }), { status: 409 });
  db.isTransaction = false;
  await assert.rejects(assertCycleTransactionsUnfrozen('20', db, { groupId: '1' }), { status: 500 });
});

test('freeze input validation preserves bigint IDs and bounds reason text', () => {
  assert.equal(validateCycleId('9223372036854775807'), '9223372036854775807');
  assert.throws(() => validateCycleId(Number.MAX_SAFE_INTEGER + 1));
  assert.equal(validateReason(' meeting '), 'meeting');
  assert.equal(validateReason(' '), null);
  assert.throws(() => validateReason('\0'));
});
