const { test } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const migration = require('../migrations/018_scope_account_ledger');
const seed = require('../migrations/019_seed_cycle_accounts');

test('account ledger conversion, activation, concurrency and guarded rollback', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  // The supplied URL must be a dedicated disposable PostgreSQL instance.
  // A separate database avoids clobbering the main integration suite's fixtures.
  const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
  const name = `ledger_migration_${process.pid}_${Date.now()}`;
  await admin.raw('CREATE DATABASE ??', [name]);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  const db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 5 } });
  t.after(async () => { await db.destroy(); await admin.raw('DROP DATABASE ??', [name]); await admin.destroy(); });
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
  const history = await legacyPost(closed.id);
  const grouplessCycle = await legacyPost(null);
  const oldPostings = await db('transaction_entries').orderBy('id');
  await db('transactions').where({id:history.id}).update({amount:'999.00'});
  await assert.rejects(db.transaction(trx => migration.up(trx)), /Legacy header\/ledger mismatch/);
  assert.equal(await db.schema.hasTable('account_entries'),false);
  assert.deepEqual(await db('transaction_entries').orderBy('id'),oldPostings);
  await db('transactions').where({id:history.id}).update({amount:'1000.00'});
  await db.transaction(trx => migration.up(trx));
  const converted = await db('account_entries').orderBy('id');
  assert.deepEqual(converted.map(p => [p.id,p.amount,p.description,p.created_at,p.updated_at]),oldPostings.map(p => [p.id,p.debit==='0.00'?`-${p.credit}`:p.debit,p.description,p.created_at,p.updated_at]));
  const component = await db('transaction_entries').where({transaction_id:history.id});
  assert.equal(component.length,1); assert.equal(component[0].type,'LOAN_DISBURSEMENT');
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
  assert.equal((await db('account_entries')).length,4);
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
  assert.equal((await db('account_entries').where({id:converted[1].id}).first()).amount,'-1000.00');
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
    const [header] = await trx('transactions').insert({group_id:group.id,type:'EXPENSE',amount:'10.00',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}).returning('*');
    const [c] = await trx('transaction_entries').insert({group_id:group.id,transaction_id:header.id,type:header.type,amount:header.amount,created_at:header.created_at,updated_at:header.updated_at}).returning('*');
    await trx('account_entries').insert(accounts.map((a,i)=>({group_id:group.id,transaction_entry_id:c.id,account_id:a.id,amount:i===0?'-10.00':'10.00',description:'Round trip'})));
    await trx('transactions').where({id:header.id}).update({updated_at:header.updated_at});
    return header;
  });
  const roundTrip = await db('account_entries').orderBy('id');
  await db.transaction(trx => migration.down(trx));
  assert.deepEqual(await db('transactions').where({id:restoredHeader.id}).first(),restoredHeader);
  assert.deepEqual((await db('transaction_entries').orderBy('id')).map(p=>[p.id,p.debit,p.credit,p.description]),roundTrip.map(p=>[p.id,p.amount[0]==='-'?'0.00':p.amount,p.amount[0]==='-'?p.amount.slice(1):'0.00',p.description]));
  assert.equal(await db.schema.hasColumn('transaction_entries','debit'),true);
  await db.transaction(trx => migration.up(trx));
  assert.equal(await db.schema.hasColumn('transaction_entries','account_id'),false);
});
