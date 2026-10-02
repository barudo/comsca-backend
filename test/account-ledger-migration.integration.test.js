const { test } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const migration = require('../migrations/018_scope_account_ledger');
const seed = require('../migrations/019_seed_cycle_accounts');
const validation = require('../migrations/021_validate_account_entries_after_changes');

async function applyLedger(trx) {
  await migration.up(trx);
  await validation.up(trx);
}

test('account ledger conversion, activation, concurrency and guarded rollback', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  // The supplied URL must be a dedicated disposable PostgreSQL instance.
  // A separate database avoids clobbering the main integration suite's fixtures.
  const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
  const name = `ledger_migration_${process.pid}_${Date.now()}`;
  let created = false;
  let db;
  t.after(async () => {
    try { if (db) await db.destroy(); if (created) await admin.raw('DROP DATABASE ??', [name]); }
    finally { await admin.destroy(); }
  });
  await admin.raw('CREATE DATABASE ??', [name]);
  created = true;
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 5 } });
  // Minimal faithful accounting dependencies avoid cluster-wide authentication roles.
  await db.raw(`CREATE TABLE groups(id bigserial PRIMARY KEY);
    CREATE TABLE cycles(id bigserial PRIMARY KEY,group_id bigint REFERENCES groups(id),status text NOT NULL DEFAULT 'draft', UNIQUE(group_id,id));
    CREATE TABLE users(id bigserial PRIMARY KEY,group_id bigint REFERENCES groups(id));
    CREATE TABLE cycle_members(cycle_id bigint REFERENCES cycles(id),user_id bigint REFERENCES users(id),PRIMARY KEY(cycle_id,user_id));`);
  await db.transaction(trx => require('../migrations/005_create_transactions').up(trx));
  await db.transaction(trx => require('../migrations/006_create_accounts_and_transaction_entries').up(trx));
  const [group, otherGroup] = await db('groups').insert([{id:1}, {id:2}]).returning('id');
  const [closed, active, distributing, draft] = await db('cycles').insert(['closed','active','distributing','draft'].map(status => ({group_id: group.id,status}))).returning('*');
  const [cash, loans] = await db('accounts').insert([
    {group_id: group.id,code:'1000',name:'Cash',type:'ASSET'},
    {group_id: group.id,code:'1100',name:'Loans Receivable',type:'ASSET'},
  ]).returning('*');
  const legacyPost = cycle => db.transaction(async trx => {
    const [header] = await trx('transactions').insert({group_id:group.id,cycle_id:cycle,type:'LOAN_DISBURSEMENT',amount:'1000.00',description:'Historical loan'}).returning('*');
    await trx('transaction_entries').insert([
      {group_id:group.id,transaction_id:header.id,account_id:loans.id,debit:'1000.00',description:'Loan debit'},
      {group_id:group.id,transaction_id:header.id,account_id:cash.id,credit:'1000.00',description:'Cash credit'},
    ]); return header;
  });
  const [secondClosed] = await db('cycles').insert({group_id:group.id,status:'closed'}).returning('id');
  await legacyPost(secondClosed.id);
  const history = await legacyPost(closed.id);
  const grouplessCycle = await legacyPost(null);
  const oldPostings = await db('transaction_entries').orderBy('id');
  await db('transactions').where({id:history.id}).update({amount:'999.00'});
  await assert.rejects(db.transaction(trx => applyLedger(trx)), /Legacy header\/ledger mismatch/);
  assert.equal(await db.schema.hasTable('account_entries'),false);
  assert.deepEqual(await db('transaction_entries').orderBy('id'),oldPostings);
  await db('transactions').where({id:history.id}).update({amount:'1000.00'});
  await db.transaction(trx => applyLedger(trx));
  const converted = await db('account_entries').orderBy('id');
  // Immediate constraints must inspect the state after a posting mutation.
  await assert.rejects(db.transaction(async trx => {
    await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
    await trx('account_entries').where({id:converted[0].id}).del();
  }), {code:'23514'});
  assert.deepEqual(await db('account_entries').orderBy('id'), converted);
  for (const amount of ['0.00', 'NaN']) {
    await assert.rejects(db('account_entries').where({id:converted[0].id}).update({amount}), {code:'23514'});
  }

  assert.deepEqual(converted.map(p => [p.id,p.amount,p.description,p.created_at,p.updated_at]),oldPostings.map(p => [p.id,p.debit==='0.00'?`-${p.credit}`:p.debit,p.description,p.created_at,p.updated_at]));
  const component = await db('transaction_entries').where({transaction_id:history.id});
  assert.equal(component.length,1); assert.equal(component[0].type,'LOAN_DISBURSEMENT');
  // Every historical posting keeps its definition while each cycle gets a distinct account.
  for (const posting of converted) {
    const old = oldPostings.find(p => p.id === posting.id);
    const original = [cash, loans].find(a => a.id === old.account_id);
    const header = await db('transactions').where({id:old.transaction_id}).first();
    const account = await db('accounts').where({id:posting.account_id}).first();
    assert.equal(account.cycle_id, header.cycle_id);
    for (const field of ['code','name','type','description']) assert.equal(account[field], original[field]);
    if (header.cycle_id) assert.notEqual(account.id, original.id);
    else assert.equal(account.id, original.id);
  }
  for (const amount of ['0.00', '-1.00']) {
    await assert.rejects(db('transaction_entries').where({id:component[0].id}).update({amount}), {code:'23514'});
  }

  const closedAccounts = await db('accounts').where({cycle_id:closed.id}).orderBy('id');
  assert.equal(closedAccounts.length,2);
  assert.equal((await db('accounts').whereNull('cycle_id')).length,2);
  assert.equal((await db('account_entries').where({transaction_entry_id:(await db('transaction_entries').where({transaction_id:grouplessCycle.id}).first()).id}).first()).account_id,loans.id);
  const [conflict] = await db('accounts').insert({group_id:group.id,cycle_id:active.id,code:'1000',name:'Incompatible',type:'ASSET'}).returning('id');
  await assert.rejects(db.transaction(trx => seed.up(trx)), /Incompatible reserved/);
  assert.equal((await db('accounts').where({cycle_id:distributing.id})).length,0);
  await db('accounts').where({id:conflict.id}).del();
  await db.transaction(trx => seed.up(trx));
  for (const cycle of [active,distributing]) assert.equal((await db('accounts').where({cycle_id:cycle.id})).length,11);
  assert.deepEqual(await db('accounts').where({cycle_id:closed.id}).orderBy('id'),closedAccounts);
  await db('cycles').where({id:draft.id}).update({status:'active'});
  const chart = await db('accounts').where({cycle_id:draft.id}).orderBy('id');
  assert.equal(chart.length,11);
  await db('cycles').where({id:draft.id}).update({status:'active'});
  assert.deepEqual(await db('accounts').where({cycle_id:draft.id}).orderBy('id'),chart);
  assert.equal((await db('account_entries')).length,oldPostings.length);
  const [bad] = await db('cycles').insert({group_id:group.id}).returning('*');
  await db('accounts').insert({group_id:group.id,cycle_id:bad.id,code:'1000',name:'Custom cash',type:'ASSET'});
  await assert.rejects(db('cycles').where({id:bad.id}).update({status:'active'}),{code:'23514'});
  assert.equal((await db('cycles').where({id:bad.id}).first()).status,'draft');
  assert.equal((await db('accounts').where({cycle_id:bad.id})).length,1);
  await assert.rejects(db('accounts').where({id:closedAccounts[0].id}).update({cycle_id:active.id}),{code:'23514'});
  await assert.rejects(db('accounts').where({id:cash.id}).update({group_id:otherGroup.id}),{code:'23514'});
  await assert.rejects(db('transactions').where({id:history.id}).update({cycle_id:active.id}),{code:'23514'});
  await assert.rejects(db('transactions').where({id:history.id}).update({cycle_id:null}),{code:'23514'});
  await assert.rejects(db('transactions').where({id:history.id}).update({group_id:otherGroup.id}),{code:'23503'});
  // Membership FKs and optionality remain intact.
  const [member] = await db('users').insert({group_id:group.id}).returning('*');
  await assert.rejects(db('transactions').where({id:history.id}).update({user_id:member.id}),{code:'23503'});
  await db('cycle_members').insert({cycle_id:closed.id,user_id:member.id});
  await db('transactions').where({id:history.id}).update({user_id:member.id});
  const cycleCash = chart.find(a => a.code==='1000');
  await assert.rejects(db('account_entries').where({id:converted[0].id}).update({account_id:cycleCash.id}),{code:'23514'});
  // Two balanced rewrites contend on the same header, even on different posting rows.
  const first = await db.transaction(); const second = await db.transaction();
  try {
    const entries = await first('account_entries').where({transaction_entry_id:component[0].id});
    await first('account_entries').where({id:entries[0].id}).update({description:'writer one'});
    const {rows:[{pid}]} = await second.raw('SELECT pg_backend_pid() AS pid');
    const pending = second('account_entries').where({id:entries[1].id}).update({amount:'-999.00'}).then(() => null,e => e);
    let blocked=false;
    for(let i=0;i<100;i++) { const {rows} = await db.raw('SELECT cardinality(pg_blocking_pids(?))>0 AS blocked',[pid]); if(rows[0].blocked){blocked=true;break;} await new Promise(r=>setTimeout(r,20)); }
    assert.equal(blocked,true); await first.commit(); assert.equal(await pending,null);
    const outcome = assert.rejects(second.executionPromise,{code:'23514'});
    await second.commit(); await outcome;
  } finally { if(!first.isCompleted())await first.rollback(); if(!second.isCompleted())await second.rollback(); }
  assert.equal((await db('account_entries').where({transaction_entry_id:component[0].id}).where('amount','<',0).first()).amount,'-1000.00');
  await t.test('new cycle defaults omit interest receivable and preserve existing ledgers through rollback', async defaultsTest => {
    const defaults = require('../migrations/025_remove_interest_receivable_from_cycle_defaults');
    const interest = chart.find(a => a.code === '1200');
    const income = chart.find(a => a.code === '4000');
    await db.transaction(async trx => {
      const [header] = await trx('transactions').insert({group_id:group.id,cycle_id:draft.id,type:'LOAN_INTEREST',amount:'25.00'}).returning('id');
      const [entry] = await trx('transaction_entries').insert({group_id:group.id,transaction_id:header.id,type:'LOAN_INTEREST',amount:'25.00'}).returning('id');
      await trx('account_entries').insert([
        {group_id:group.id,transaction_entry_id:entry.id,account_id:interest.id,amount:'25.00'},
        {group_id:group.id,transaction_entry_id:entry.id,account_id:income.id,amount:'-25.00'},
      ]);
    });
    const existingAccounts = await db('accounts').orderBy('id');
    const existingPostings = await db('account_entries').orderBy('id');
    await db.transaction(trx => defaults.up(trx));
    assert.deepEqual(await db('accounts').orderBy('id'), existingAccounts);
    assert.deepEqual(await db('account_entries').orderBy('id'), existingPostings);
    await db.raw('SELECT public.seed_cycle_accounts(?, ?)', [group.id, draft.id]);
    assert.deepEqual(await db('accounts').orderBy('id'), existingAccounts);
    assert.deepEqual(await db('account_entries').orderBy('id'), existingPostings);
    const definitions = rows => rows.map(a => [a.code, a.name, a.type]).sort((a, b) => a[0].localeCompare(b[0]));
    const expectedDefaults = definitions(chart.filter(a => a.code !== '1200'));
    const newCycles = [];
    for (const status of ['active', 'distributing']) {
      const [cycle] = await db('cycles').insert({group_id:group.id}).returning('id');
      newCycles.push(cycle);
      await db('cycles').where({id:cycle.id}).update({status});
      const accounts = await db('accounts').where({cycle_id:cycle.id}).orderBy('id');
      assert.equal(accounts.length, 10);
      assert.equal(accounts.some(a => a.code === '1200'), false);
      assert.deepEqual(definitions(accounts), expectedDefaults);
      await db('cycles').where({id:cycle.id}).update({status});
      await db.raw('SELECT public.seed_cycle_accounts(?, ?)', [group.id, cycle.id]);
      assert.deepEqual(await db('accounts').where({cycle_id:cycle.id}).orderBy('id'), accounts);
    }
    const [insertedActive] = await db('cycles').insert({group_id:group.id,status:'active'}).returning('id');
    assert.equal((await db('accounts').where({cycle_id:insertedActive.id})).length, 10);
    const [preexisting] = await db('cycles').insert({group_id:group.id}).returning('id');
    const [retained] = await db('accounts').insert({group_id:group.id,cycle_id:preexisting.id,
      code:'1200',name:'Interest Receivable',type:'ASSET'}).returning('*');
    await db('cycles').where({id:preexisting.id}).update({status:'active'});
    assert.equal((await db('accounts').where({cycle_id:preexisting.id})).length, 11);
    assert.deepEqual(await db('accounts').where({id:retained.id}).first(), retained);
    const [incompatible] = await db('cycles').insert({group_id:group.id}).returning('id');
    await db('accounts').insert({group_id:group.id,cycle_id:incompatible.id,code:'1100',name:'Wrong loans',type:'ASSET'});
    await assert.rejects(db('cycles').where({id:incompatible.id}).update({status:'active'}), {code:'23514'});
    assert.equal((await db('cycles').where({id:incompatible.id}).first()).status, 'draft');
    assert.equal((await db('accounts').where({cycle_id:incompatible.id})).length, 1);
    await defaultsTest.test('contribution defaults activate without backfilling and rollback preserves postings', async () => {
      const contributions = require('../migrations/026_add_contribution_cycle_accounts');
      const beforeAccounts = await db('accounts').orderBy('id');
      const beforePostings = await db('account_entries').orderBy('id');
      await db.transaction(trx => contributions.up(trx));
      assert.deepEqual(await db('accounts').orderBy('id'), beforeAccounts);
      assert.deepEqual(await db('account_entries').orderBy('id'), beforePostings);
      const expected = [...expectedDefaults,
        ['1400', 'Contributions Receivable', 'ASSET'],
        ['4400', 'Contribution Income', 'INCOME']].sort((a, b) => a[0].localeCompare(b[0]));
      await db('cycles').where({id:newCycles[0].id}).update({status:'distributing'});
      assert.deepEqual(definitions(await db('accounts').where({cycle_id:newCycles[0].id})), expected);
      const upgradedAccounts = await db('accounts').where({cycle_id:newCycles[0].id}).orderBy('id');
      await db.raw('SELECT public.seed_cycle_accounts(?, ?)', [group.id, newCycles[0].id]);
      assert.deepEqual(await db('accounts').where({cycle_id:newCycles[0].id}).orderBy('id'), upgradedAccounts);
      let contributionChart;
      let contributionCycle;
      for (const status of ['active', 'distributing']) {
        const [cycle] = await db('cycles').insert({group_id:group.id}).returning('id');
        await db('cycles').where({id:cycle.id}).update({status});
        const accounts = await db('accounts').where({cycle_id:cycle.id}).orderBy('id');
        assert.equal(accounts.length, 12);
        assert.deepEqual(definitions(accounts), expected);
        await db('cycles').where({id:cycle.id}).update({status});
        await db.raw('SELECT public.seed_cycle_accounts(?, ?)', [group.id, cycle.id]);
        assert.deepEqual(await db('accounts').where({cycle_id:cycle.id}).orderBy('id'), accounts);
        contributionChart = accounts;
        contributionCycle = cycle;
      }
      const [direct] = await db('cycles').insert({group_id:group.id,status:'active'}).returning('id');
      assert.deepEqual(definitions(await db('accounts').where({cycle_id:direct.id})), expected);
      const [partial] = await db('cycles').insert({group_id:group.id}).returning('id');
      const compatible = await db('accounts').insert([
        {group_id:group.id,cycle_id:partial.id,code:'1400',name:'Contributions Receivable',type:'ASSET'},
        {group_id:group.id,cycle_id:partial.id,code:'4400',name:'Contribution Income',type:'INCOME'},
      ]).returning('*');
      await db('cycles').where({id:partial.id}).update({status:'active'});
      assert.deepEqual(definitions(await db('accounts').where({cycle_id:partial.id})), expected);
      assert.deepEqual(await db('accounts').whereIn('id',compatible.map(a => a.id)).orderBy('id'), compatible);
      for (const [code, name, type] of [['1400', 'Custom receivable', 'ASSET'], ['4400', 'Contribution Income', 'ASSET']]) {
        const [cycle] = await db('cycles').insert({group_id:group.id}).returning('id');
        await db('accounts').insert({group_id:group.id,cycle_id:cycle.id,code,name,type});
        await assert.rejects(db('cycles').where({id:cycle.id}).update({status:'active'}), {code:'23514'});
        assert.equal((await db('cycles').where({id:cycle.id}).first()).status, 'draft');
        assert.equal((await db('accounts').where({cycle_id:cycle.id})).length, 1);
      }
      await db.transaction(async trx => {
        const [header] = await trx('transactions').insert({group_id:group.id,cycle_id:contributionCycle.id,type:'CONTRIBUTION',amount:'50.00'}).returning('id');
        const [entry] = await trx('transaction_entries').insert({group_id:group.id,transaction_id:header.id,type:'CONTRIBUTION',amount:'50.00'}).returning('id');
        await trx('account_entries').insert([
          {group_id:group.id,transaction_entry_id:entry.id,account_id:contributionChart.find(a => a.code === '1400').id,amount:'50.00'},
          {group_id:group.id,transaction_entry_id:entry.id,account_id:contributionChart.find(a => a.code === '4400').id,amount:'-50.00'},
        ]);
      });
      const accountsBeforeDown = await db('accounts').orderBy('id');
      const postingsBeforeDown = await db('account_entries').orderBy('id');
      await db.transaction(trx => contributions.down(trx));
      assert.deepEqual(await db('accounts').orderBy('id'), accountsBeforeDown);
      assert.deepEqual(await db('account_entries').orderBy('id'), postingsBeforeDown);
      await db.raw('SELECT public.seed_cycle_accounts(?, ?)', [group.id, contributionCycle.id]);
      assert.deepEqual(await db('accounts').orderBy('id'), accountsBeforeDown);
      assert.deepEqual(await db('account_entries').orderBy('id'), postingsBeforeDown);
      const [restored] = await db('cycles').insert({group_id:group.id,status:'active'}).returning('id');
      assert.deepEqual(definitions(await db('accounts').where({cycle_id:restored.id})), expectedDefaults);
      await db.transaction(trx => contributions.up(trx));
      const assistance = require('../migrations/028_add_member_assistance_expense_account');
      const beforeAssistanceAccounts = await db('accounts').orderBy('id');
      const beforeAssistancePostings = await db('account_entries').orderBy('id');
      await db.transaction(trx => assistance.up(trx));
      assert.deepEqual(await db('accounts').orderBy('id'), beforeAssistanceAccounts);
      assert.deepEqual(await db('account_entries').orderBy('id'), beforeAssistancePostings);
      const assistanceExpected = [...expected, ['5100', 'Member Assistance Expense', 'EXPENSE']]
        .sort((a, b) => a[0].localeCompare(b[0]));
      const assistanceCycles = [];
      for (const status of ['active', 'distributing']) {
        const [cycle] = await db('cycles').insert({group_id:group.id}).returning('id');
        assistanceCycles.push(cycle);
        await db('cycles').where({id:cycle.id}).update({status});
        const accounts = await db('accounts').where({cycle_id:cycle.id}).orderBy('id');
        assert.equal(accounts.length, 13);
        assert.deepEqual(definitions(accounts), assistanceExpected);
        assert.ok(accounts.every(account => account.group_id === group.id && account.cycle_id === cycle.id));
        await db('cycles').where({id:cycle.id}).update({status});
        assert.deepEqual(await db('accounts').where({cycle_id:cycle.id}).orderBy('id'), accounts);
      }
      const [compatibleCycle] = await db('cycles').insert({group_id:group.id}).returning('id');
      const [compatibleExpense] = await db('accounts').insert({group_id:group.id,cycle_id:compatibleCycle.id,
        code:'5100',name:'Member Assistance Expense',type:'EXPENSE'}).returning('*');
      await db('cycles').where({id:compatibleCycle.id}).update({status:'active'});
      assert.equal((await db('accounts').where({cycle_id:compatibleCycle.id})).length, 13);
      assert.deepEqual(await db('accounts').where({id:compatibleExpense.id}).first(), compatibleExpense);
      const compatibleAccounts = await db('accounts').where({cycle_id:compatibleCycle.id}).orderBy('id');
      await db('cycles').where({id:compatibleCycle.id}).update({status:'active'});
      assert.deepEqual(await db('accounts').where({cycle_id:compatibleCycle.id}).orderBy('id'), compatibleAccounts);
      const [conflictCycle] = await db('cycles').insert({group_id:group.id}).returning('id');
      await db('accounts').insert({group_id:group.id,cycle_id:conflictCycle.id,
        code:'5100',name:'Custom Assistance Expense',type:'EXPENSE'});
      await assert.rejects(db('cycles').where({id:conflictCycle.id}).update({status:'active'}), {code:'23514'});
      assert.equal((await db('cycles').where({id:conflictCycle.id}).first()).status, 'draft');
      assert.equal((await db('accounts').where({cycle_id:conflictCycle.id})).length, 1);
      const expense = (await db('accounts').where({cycle_id:assistanceCycles[0].id})).find(account => account.code === '5100');
      await db.transaction(async trx => {
        const [header] = await trx('transactions').insert({group_id:group.id,cycle_id:assistanceCycles[0].id,
          type:'OTHER',amount:'10.00'}).returning('id');
        const [entry] = await trx('transaction_entries').insert({group_id:group.id,transaction_id:header.id,
          type:'OTHER',amount:'10.00'}).returning('id');
        await trx('account_entries').insert([
          {group_id:group.id,transaction_entry_id:entry.id,account_id:expense.id,amount:'10.00'},
          {group_id:group.id,transaction_entry_id:entry.id,account_id:cash.id,amount:'-10.00'},
        ]);
      });
      const beforeAssistanceDownAccounts = await db('accounts').orderBy('id');
      const beforeAssistanceDownPostings = await db('account_entries').orderBy('id');
      await db.transaction(trx => assistance.down(trx));
      assert.deepEqual(await db('accounts').orderBy('id'), beforeAssistanceDownAccounts);
      assert.deepEqual(await db('account_entries').orderBy('id'), beforeAssistanceDownPostings);
      const [priorTemplateCycle] = await db('cycles').insert({group_id:group.id,status:'active'}).returning('id');
      const priorTemplate = await db('accounts').where({cycle_id:priorTemplateCycle.id});
      assert.equal(priorTemplate.length, 12);
      assert.equal(priorTemplate.some(account => account.code === '5100'), false);
    });
    const postingsBeforeRollback = await db('account_entries').orderBy('id');
    const beforeRollback = await db('accounts').orderBy('id');
    await db.transaction(trx => defaults.down(trx));
    assert.deepEqual(await db('accounts').orderBy('id'), beforeRollback);
    assert.deepEqual(await db('account_entries').orderBy('id'), postingsBeforeRollback);
    const [restored] = await db('cycles').insert({group_id:group.id,status:'active'}).returning('id');
    const restoredChart = await db('accounts').where({cycle_id:restored.id});
    assert.equal(restoredChart.length, 11);
    assert.equal(restoredChart.find(a => a.code === '1200').name, 'Interest Receivable');
    assert.deepEqual(definitions(restoredChart), definitions(chart));
    assert.equal((await db('accounts').where({cycle_id:newCycles[0].id})).length, 12);
    assert.equal((await db('accounts').where({cycle_id:newCycles[1].id})).length, 10);
    await db('cycles').where({id:newCycles[1].id}).update({status:'active'});
    assert.deepEqual(definitions(await db('accounts').where({cycle_id:newCycles[1].id})), definitions(chart));
  });
  await t.test('member contribution entries enforce scope, balance and guarded rollback', async () => {
    const memberEntries = require('../migrations/027_add_contribution_member_entries');
    const before = await db('transaction_entries').orderBy('id');
    await db.transaction(trx => memberEntries.up(trx));
    assert.deepEqual((await db('transaction_entries').orderBy('id')).map(({user_id,cycle_id,...entry}) => {
      assert.equal(user_id, null); assert.equal(cycle_id, null); return entry;
    }), before);
    // Rollback is safe while all existing components retain their old shape.
    await db.transaction(trx => memberEntries.down(trx));
    assert.deepEqual(await db('transaction_entries').orderBy('id'), before);
    await db.transaction(trx => memberEntries.up(trx));
    const members = await db('users').insert([{group_id:group.id}, {group_id:group.id}, {group_id:group.id}]).returning('id');
    const [outsider] = await db('users').insert({group_id:otherGroup.id}).returning('id');
    const [unenrolled] = await db('users').insert({group_id:group.id}).returning('id');
    await db('cycle_members').insert(members.map(user => ({cycle_id:closed.id,user_id:user.id})));
    // Even a malformed cross-group enrollment cannot bypass the entry's group FK.
    await db('cycle_members').insert({cycle_id:closed.id,user_id:outsider.id});
    const create = (overrides = {}, badPosting = false, withMembers = true, type = 'CONTRIBUTION') => db.transaction(async trx => {
      const [header] = await trx('transactions').insert({group_id:group.id,cycle_id:closed.id,type,amount:'76.50'}).returning('*');
      const entries = await trx('transaction_entries').insert(members.map(user => ({group_id:group.id,
        transaction_id:header.id,type,amount:'25.50',
        ...(withMembers ? {cycle_id:closed.id,user_id:user.id} : {}), ...overrides}))).returning('*');
      await trx('account_entries').insert(entries.flatMap(entry => [
        {group_id:group.id,transaction_entry_id:entry.id,account_id:loans.id,amount:'25.50'},
        {group_id:group.id,transaction_entry_id:entry.id,account_id:cash.id,amount:badPosting?'-25.49':'-25.50'},
      ]));
      return {header,entries};
    });
    const counts = async () => Promise.all(['transactions','transaction_entries','account_entries'].map(async table => (await db(table).count('* as count').first()).count));
    const initialCounts = await counts();
    for (const [overrides, code] of [
      [{user_id:outsider.id}, '23503'], [{user_id:unenrolled.id}, '23503'],
      [{cycle_id:active.id}, '23503'], [{cycle_id:null}, '23514'],
      [{group_id:otherGroup.id}, '23503'],
    ]) {
      await assert.rejects(create(overrides), {code});
      assert.deepEqual(await counts(), initialCounts);
    }
    await assert.rejects(create({}, true), {code:'23514'});
    assert.deepEqual(await counts(), initialCounts);
    // Existing payment and disbursement component writes still omit member columns.
    for (const type of ['PAYMENT', 'LOAN_DISBURSED']) {
      const compatible = await create({}, false, false, type);
      assert.ok(compatible.entries.every(entry => entry.user_id === null && entry.cycle_id === null));
    }
    const charged = await create();
    assert.equal(charged.header.amount, '76.50');
    assert.deepEqual(charged.entries.map(entry => entry.user_id), members.map(user => user.id));
    await assert.rejects(db('cycle_members').where({cycle_id:closed.id,user_id:members[0].id}).del(), error => ['23503', '23001'].includes(error.code));
    await assert.rejects(db('transactions').where({id:charged.header.id}).update({cycle_id:active.id}), {code:'23503'});
    await assert.rejects(db('transactions').where({id:charged.header.id}).update({cycle_id:null}), {code:'23503'});
    await assert.rejects(db.transaction(async trx => {
      await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
      await trx('account_entries').where({transaction_entry_id:charged.entries[0].id}).where('amount','>',0).del();
    }), {code:'23514'});
    const retained = await db('transaction_entries').orderBy('id');
    await assert.rejects(db.transaction(trx => memberEntries.down(trx)), /lose transaction entry member data/);
    assert.deepEqual(await db('transaction_entries').orderBy('id'), retained);
    await db.transaction(async trx => {
      await trx('account_entries').whereIn('transaction_entry_id', charged.entries.map(entry => entry.id)).del();
      await trx('transaction_entries').where({transaction_id:charged.header.id}).del();
      await trx('transactions').where({id:charged.header.id}).del();
    });
    await db.transaction(trx => memberEntries.down(trx));
    assert.equal(await db.schema.hasColumn('transaction_entries','user_id'), false);
  });
  await db.transaction(trx => seed.down(trx));
  assert.equal((await db('accounts').where({cycle_id:draft.id})).length,11);
  await assert.rejects(db.transaction(trx => migration.down(trx)),/lose account cycle ownership/);
  assert.equal(await db.schema.hasTable('account_entries'),true);
  // Empty schema rollback/up is safe and leaves no duplicate writable postings.
  await db.transaction(async trx => {
    await trx('account_entries').del(); await trx('transaction_entries').del(); await trx('transactions').del();
    await trx('accounts').del();
  });
  const restoredHeader = await db.transaction(async trx => {
    const accounts = await trx('accounts').insert([
      {group_id:group.id,code:'cash',name:'Cash',type:'ASSET'},
      {group_id:group.id,code:'expense',name:'Expense',type:'EXPENSE'},
    ]).returning('id');
    const [header] = await trx('transactions').insert({group_id:group.id,type:'EXPENSE',amount:'9999999999999999.99',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}).returning('*');
    const [c] = await trx('transaction_entries').insert({group_id:group.id,transaction_id:header.id,type:header.type,amount:header.amount,created_at:header.created_at,updated_at:header.updated_at}).returning('*');
    await trx('account_entries').insert(accounts.map((a,i)=>({group_id:group.id,transaction_entry_id:c.id,account_id:a.id,amount:i===0?`-${header.amount}`:header.amount,description:'Round trip'})));
    await trx('transactions').where({id:header.id}).update({updated_at:header.updated_at});
    return header;
  });
  const roundTrip = await db('account_entries').orderBy('id');
  // With no cycle accounts, the separate component-data rollback guard is reachable.
  const aggregate = await db('transaction_entries').where({transaction_id:restoredHeader.id}).first();
  await db('transaction_entries').where({id:aggregate.id}).update({description:'Distinct business metadata'});
  const guarded = await db('transaction_entries').orderBy('id');
  await assert.rejects(db.transaction(trx => migration.down(trx)), /lose business component data/);
  assert.deepEqual(await db('transaction_entries').orderBy('id'), guarded);
  assert.deepEqual(await db('account_entries').orderBy('id'), roundTrip);
  await db('transaction_entries').where({id:aggregate.id}).update({description:aggregate.description});
  await db('transactions').where({id:restoredHeader.id}).update({updated_at:restoredHeader.updated_at});

  await db.transaction(trx => migration.down(trx));
  assert.deepEqual(await db('transactions').where({id:restoredHeader.id}).first(),restoredHeader);
  assert.deepEqual((await db('transaction_entries').orderBy('id')).map(p=>[p.id,p.debit,p.credit,p.description]),roundTrip.map(p=>[p.id,p.amount[0]==='-'?'0.00':p.amount,p.amount[0]==='-'?p.amount.slice(1):'0.00',p.description]));
  assert.equal(await db.schema.hasColumn('transaction_entries','debit'),true);
  await db.transaction(trx => applyLedger(trx));
  assert.equal(await db.schema.hasColumn('transaction_entries','account_id'),false);
});
