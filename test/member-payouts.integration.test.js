const { test } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const fs = require('node:fs');
const path = require('node:path');
const Cycles = require('../src/handlers/cycles');
const Distributions = require('../src/handlers/cycle-distributions');
const { decimal, cents } = require('../src/services/cycle-distributions');

test('member payouts: accounting, HTTP isolation, retries, concurrency, constraints and rollback', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const admin = knex({client:'pg',connection:process.env.TEST_DATABASE_URL});
  const name = `payouts_${process.pid}_${Date.now()}`;
  let db;
  t.after(async () => { try { if(db) await db.destroy(); await admin.raw('DROP DATABASE IF EXISTS ??',[name]); } finally {await admin.destroy();} });
  await admin.raw('CREATE DATABASE ??',[name]);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  db = knex({client:'pg',connection:url.toString(),pool:{min:0,max:6}});
  const migrationRoot=path.join(__dirname,'../migrations');
  for (const file of fs.readdirSync(migrationRoot).sort()) {
    const n=Number(file.slice(0,3));
    if ([3,4,8,9].includes(n)) continue;
    await db.transaction(trx => require(path.join(migrationRoot,file)).up(trx));
    if(n===1) await db.raw("ALTER TABLE users ADD COLUMN auth_user_id text, ADD COLUMN role text DEFAULT 'OWNER'");
  }
  let seq=0;
  async function fixture() {
    seq++;
    const [group]=await db('groups').insert({name:`G${seq}`,slug:`g${seq}`}).returning('*');
    const [cycle]=await db('cycles').insert({group_id:group.id,status:'draft'}).returning('*');
    const users=await db('users').insert([1,2,3].map(i=>({group_id:group.id,username:`u${i}`,first_name:'F',family_name:'L',email:`${i}@example.test`,password:'x',auth_user_id:`a${seq}-${i}`,role:i===1?'OWNER':'MEMBER'}))).returning('*');
    await db('cycle_members').insert(users.map(u=>({cycle_id:cycle.id,user_id:u.id})));
    await db('cycles').where({id:cycle.id}).update({status:'active'});
    const accounts=await db('accounts').where({cycle_id:cycle.id});
    const byCode=Object.fromEntries(accounts.map(a=>[a.code,a.id]));
    async function post(type, amount, debit, credit, user=users[0].id, voided=false) {
      return db.transaction(async trx=>{
        const [h]=await trx('transactions').insert({group_id:group.id,cycle_id:cycle.id,user_id:user,type,amount}).returning('*');
        const [e]=await trx('transaction_entries').insert({group_id:group.id,transaction_id:h.id,cycle_id:cycle.id,user_id:user,type,amount,debit:byCode[debit],credit:byCode[credit]}).returning('*');
        const postings=await trx('account_entries').insert([{group_id:group.id,transaction_entry_id:e.id,account_id:byCode[debit],amount},{group_id:group.id,transaction_entry_id:e.id,account_id:byCode[credit],amount:decimal(-cents(amount))}]).returning('*');
        if(voided) {
          await trx('account_entries').insert(postings.map(p=>({group_id:group.id,transaction_entry_id:e.id,account_id:p.account_id,amount:decimal(-cents(p.amount)),reversal_of_id:p.id})));
          await trx('transactions').where({id:h.id}).update({status:'voided'});
        }
        return h;
      });
    }
    const request=(body={status:'distributing'})=>({app:{locals:{database:db}},group:{id:group.id},authUser:{id:users[0].auth_user_id},params:{id:cycle.id,cycleId:cycle.id},body});
    async function invoke(handler=new Cycles(),method='update',req=request()) {
      const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
      await handler[method](req,res,error=>{throw error;}); return res;
    }
    const balance=async code=> cents((await db('account_entries').where({account_id:byCode[code]}).sum('amount as value').first()).value||'0');
    return {group,cycle,users,post,request,invoke,balance,byCode};
  }
  const Payouts = require('../src/handlers/member-payouts');
  const handler = new Payouts();
  const f = await fixture();
  const body = (key, amount='25.00', user=f.users[0].id) => ({user_id:user, credit:f.byCode['1000'], amount, idempotency_key:key});
  const pay = input => f.invoke(handler,'create',f.request(input));
  const read = () => f.invoke(handler,'list');
  assert.deepEqual((await read()).body.payouts,[]);
  assert.equal((await pay(body('active'))).statusCode,409);
  await db('cycles').where({id:f.cycle.id}).update({status:'draft'});
  assert.equal((await pay(body('draft'))).statusCode,409);
  await db('cycles').where({id:f.cycle.id}).update({status:'active'});
  await f.post('BUY_SHARE','100.00','1000','3000');
  await f.post('BUY_SHARE','100.00','1000','3000',f.users[1].id);
  assert.equal((await f.invoke()).statusCode,200);
  const original = await db('cycle_distribution_declarations').where({cycle_id:f.cycle.id}).first();
  const distributions = await db('cycle_distributions').where({cycle_id:f.cycle.id}).orderBy('id');
  const payable = distributions[0].payable_account_id;
  // Exercise rollback with existing declarations but no payouts, then upgrade them.
  const migration = require('../migrations/038_create_member_payouts');
  await db.transaction(trx => migration.down(trx));
  await assert.rejects(db('cycle_distributions').where({id:distributions[0].id}).update({updated_at:db.fn.now()}), /immutable/);
  await db.transaction(trx => migration.up(trx));
  assert.deepEqual(await db('cycle_distributions').where({cycle_id:f.cycle.id}).orderBy('id'), distributions);
  assert.deepEqual(await db('cycle_distribution_declarations').where({cycle_id:f.cycle.id}).first(), original);
  const replies = await Promise.all([pay(body('first')),pay(body('first','25')),pay(body('first',25))]);
  assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,200,201]);
  assert.equal(new Set(replies.map(r=>r.body.payout.id)).size,1);
  assert.equal(replies[0].body.distribution.status,'partial');
  assert.equal((await pay(body('first','24.00'))).statusCode,409);
  assert.equal((await pay({...body('first'),user_id:f.users[1].id})).statusCode,409);
  assert.equal((await pay(body('over','75.01'))).statusCode,409);
  for(const credit of [f.byCode['1100'],f.byCode['1300'],f.byCode['1400'],f.byCode['3000']]) assert.equal((await pay({...body(`bad-${credit}`),credit})).statusCode,400);
  const foreign = await fixture();
  assert.equal((await pay({...body('foreign-account'),credit:foreign.byCode['1000']})).statusCode,404);
  assert.equal((await pay({...body('foreign-member'),user_id:foreign.users[0].id})).statusCode,404);
  const concurrent = await Promise.all([pay(body('final-a','75')),pay(body('final-b','75'))]);
  assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[201,409]);
  assert.equal(concurrent.find(r=>r.statusCode===201).body.distribution.status,'paid');
  assert.equal(await f.balance('1000'),10000n);
  assert.equal((await db('account_entries').where({account_id:payable}).sum('amount as v').first()).v,'-100.00');
  assert.equal((await f.invoke(new Distributions(),'list')).body.summary.total_paid,'100.00');
  assert.deepEqual(await db('cycle_distribution_declarations').where({cycle_id:f.cycle.id}).first(),original);
  const updated = await db('cycle_distributions').where({cycle_id:f.cycle.id}).orderBy('id');
  const entitlement = row => Object.fromEntries(Object.entries(row).filter(([key])=>!['paid_amount','status','updated_at'].includes(key)));
  assert.deepEqual(updated.map(entitlement),distributions.map(entitlement));
  await assert.rejects(db('cycle_distributions').where({id:updated[0].id}).update({net_amount:'101.00'}));
  await assert.rejects(db('cycle_distributions').where({id:updated[1].id}).update({paid_amount:'1.00',status:'partial'}));
  await assert.rejects(db('cycle_distributions').where({id:updated[0].id}).delete());
  await assert.rejects(db('member_payouts').where({cycle_id:f.cycle.id}).update({amount:'1.00'}));
  await assert.rejects(db('member_payouts').where({cycle_id:f.cycle.id}).delete());
  await assert.rejects(db.transaction(trx=>require('../migrations/038_create_member_payouts').down(trx)),/lose payout/);
  const snapshot = async () => ({cash:await f.balance('1000'),cycle:await db('cycles').where({id:f.cycle.id}).first(),
    transactions:await db('transactions').where({cycle_id:f.cycle.id}).orderBy('id'),distributions:await db('cycle_distributions').where({cycle_id:f.cycle.id}).orderBy('id')});
  const before = await snapshot();
  await db.raw(`CREATE FUNCTION fail_payout_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER fail_payout_test BEFORE INSERT ON member_payouts FOR EACH ROW EXECUTE FUNCTION fail_payout_test()`);
  assert.equal((await pay(body('rollback','10',f.users[1].id))).statusCode,409);
  assert.deepEqual(await snapshot(),before);
  await db.raw('DROP TRIGGER fail_payout_test ON member_payouts; DROP FUNCTION fail_payout_test()');
  // An external cash reduction leaves entitlement intact but prevents funding overdraw.
  await f.post('EXPENSE','90.00','5000','1000',null);
  const cashRace = await Promise.all([pay(body('cash-a','10',f.users[1].id)),pay(body('cash-b','10',f.users[1].id))]);
  assert.deepEqual(cashRace.map(r=>r.statusCode).sort(),[201,409]);
  assert.equal(await f.balance('1000'),0n);
  const app = require('serverless-http')(require('../src/app').createApp(db,{getUser:async ({access_token})=>({id:access_token})}));
  const http = async (method,actor=f.users[0],group=f.group,payload=body('http')) => app({version:'2.0',rawPath:`/api/v1/cycles/${f.cycle.id}/payouts`,rawQueryString:'',headers:{authorization:`Bearer ${actor.auth_user_id}`,'x-group-slug':group.slug,'content-type':'application/json'},requestContext:{http:{method,sourceIp:'127.0.0.1'}},...(method==='POST'?{body:JSON.stringify(payload)}:{})},{});
  assert.equal((await http('GET')).statusCode,200);
  // A custom cash account can fund HTTP payouts; classifications must be explicit.
  const [custom] = await db('accounts').insert({group_id:f.group.id,cycle_id:f.cycle.id,code:'1015',name:'Custom cash',type:'ASSET',distribution_role:'CASH'}).returning('*');
  f.byCode['1015'] = custom.id;
  await f.post('DONATION','5.00','1015','4300',null);
  const customBody = {...body('custom-cash','5.00',f.users[1].id),credit:custom.id};
  const posted = await http('POST',f.users[0],f.group,customBody);
  assert.equal(posted.statusCode,201,posted.body);
  const parsed = JSON.parse(posted.body);
  assert.equal(parsed.distribution.paid_amount,'15.00');
  assert.equal(parsed.transaction.type,'MEMBER_PAYOUT');
  assert.equal(parsed.transaction.document_type,'DISBURSEMENT_VOUCHER');
  const replay = await http('POST',f.users[0],f.group,customBody);
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(JSON.parse(replay.body).payout.id,parsed.payout.id);
  assert.equal((await db('account_entries').join('transaction_entries','transaction_entries.id','account_entries.transaction_entry_id').where('transaction_entries.transaction_id',parsed.transaction.id)).length,2);
  assert.equal(await f.balance('1015'),0n);
  await db('accounts').where({id:custom.id}).update({distribution_role:null});
  assert.equal((await pay({...customBody,idempotency_key:'unclassified'})).statusCode,400);
  await db('accounts').where({id:f.byCode['1100']}).update({distribution_role:'CASH'});
  assert.equal((await pay({...body('misclassified','1',f.users[1].id),credit:f.byCode['1100']})).statusCode,400);
  await db('accounts').where({id:payable}).update({distribution_role:null});
  assert.equal((await pay(body('bad-payable','1',f.users[1].id))).statusCode,400);
  await db('accounts').where({id:payable}).update({distribution_role:'DISTRIBUTION_PAYABLE'});
  assert.equal((await http('GET',foreign.users[0],foreign.group)).statusCode,404);
  assert.equal((await http('GET',f.users[2])).statusCode,403);
  assert.equal((await http('POST',f.users[2])).statusCode,403);
  await db('users').where({id:f.users[2].id}).update({role:'AUDITOR'});
  assert.equal((await http('GET',f.users[2])).statusCode,200);
  assert.equal((await http('POST',f.users[2])).statusCode,403);
  assert.equal((await http('POST',f.users[0],f.group,{...body('bad'),debit:payable})).statusCode,400);
  const payouts=(await read()).body.payouts;
  assert.deepEqual(payouts.map(p=>p.id),[...payouts].sort((a,b)=>Number(a.id)-Number(b.id)).map(p=>p.id));
  await db.transaction(async trx=>{await trx.raw('SET LOCAL ROLE comsca_group_reader');await trx.raw("SELECT set_config('app.group_id',?,true)",[String(foreign.group.id)]);assert.deepEqual(await trx('member_payouts'),[]);});
  assert.equal((await f.invoke(new Cycles(),'update',f.request({status:'closed'}))).statusCode,200);
  assert.equal((await pay(body('first'))).statusCode,409);
  assert.equal((await read()).body.cycle.status,'closed');
  assert.equal((await read()).body.payouts.length,4);
});
