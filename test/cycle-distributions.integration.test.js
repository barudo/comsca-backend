const { test } = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');
const fs = require('node:fs');
const path = require('node:path');
const Cycles = require('../src/handlers/cycles');
const Distributions = require('../src/handlers/cycle-distributions');
const Transactions = require('../src/handlers/transactions');
const { decimal, cents } = require('../src/services/cycle-distributions');

test('distribution accounting: real constraints, loan offsets, blockers, concurrency, isolation and rollback', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const admin = knex({client:'pg',connection:process.env.TEST_DATABASE_URL});
  const name = `distributions_${process.pid}_${Date.now()}`;
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
  const f=await fixture();
  for(let i=0;i<3;i++) await f.post('BUY_SHARE',`${(i+1)*100}.00`,'1000','3000',f.users[i].id);
  await f.post('DONATION','170.00','1000','4300',null);
  await f.post('LOAN_DISBURSED','50.00','1100','1000');
  await f.post('BUY_SHARE','999.99','1000','3000',f.users[0].id,true);
  const beforeCash=await f.balance('1000');
  const concurrent=await Promise.all([f.invoke(),f.invoke(),f.invoke()]);
  for(const r of concurrent) assert.equal(r.statusCode,200,JSON.stringify(r.body));
  const result=concurrent[0].body;
  assert.equal(result.cycle.status,'distributing');
  assert.equal(result.summary.total_capital,'600.00'); assert.equal(result.summary.net_earnings,'170.00');
  assert.equal(result.summary.total_deductions,'50.00'); assert.equal(result.summary.net_distribution,'720.00');
  assert.deepEqual(result.distributions.map(r=>r.earnings_amount),['28.33','56.67','85.00']);
  assert.equal(result.distributions[0].loan_deduction,'50.00');
  assert.equal(await f.balance('1100'),0n); assert.equal(await f.balance('1000'),beforeCash);
  assert.equal(await f.balance('3000'),0n); assert.equal(await f.balance('4300'),0n);
  const payable=await db('accounts').where({cycle_id:f.cycle.id,distribution_role:'DISTRIBUTION_PAYABLE'}).first();
  assert.equal((await db('account_entries').where({account_id:payable.id}).sum('amount as amount').first()).amount,'-720.00');
  assert.equal((await db('cycle_distributions').where({cycle_id:f.cycle.id})).length,3);
  const journals=await db('transactions').where({cycle_id:f.cycle.id}).where('type','like','DISTRIBUTION%');
  const count=journals.length;
  assert.equal((await f.invoke()).statusCode,200);
  assert.equal((await db('transactions').where({cycle_id:f.cycle.id}).where('type','like','DISTRIBUTION%')).length,count);
  assert.equal((await f.invoke(new Distributions(),'list')).body.summary.net_distribution,'720.00');
  const other=await fixture(); const cross=f.request();cross.group.id=other.group.id; cross.authUser.id=other.users[0].auth_user_id;
  assert.equal((await f.invoke(new Distributions(),'list',cross)).statusCode,404);
  const unauthorized=f.request();unauthorized.authUser.id=f.users[1].auth_user_id;
  assert.equal((await f.invoke(new Distributions(),'list',unauthorized)).statusCode,403);
  const voidReq=f.request();voidReq.params.transactionId=journals[0].id;
  assert.equal((await f.invoke(new Transactions(),'void',voidReq)).statusCode,409);
  assert.equal((await f.invoke(new Cycles(),'update',f.request({journal_voucher_counter:'0'}))).statusCode,409);
  await assert.rejects(db.transaction(trx=>require('../migrations/037_create_cycle_distributions').down(trx)),/lose distribution/);
  // Exercise every business write route on the declared cycle, not just query text.
  const app = require('serverless-http')(require('../src/app').createApp(db, {getUser:async()=>({id:f.users[0].auth_user_id})}));
  const routes = [
    ['/api/v1/cycles/members',{users:[f.users[0].id]}],
    ['/api/v1/contributions/charge',{debit:f.byCode['1400'],credit:f.byCode['4400'],amount:'1.00'}],
    ['/api/v1/penalties/charge',{user_id:f.users[0].id,debit:f.byCode['1300'],credit:f.byCode['4100'],amount:'1.00'}],
    ['/api/v1/interests/charge',{debit:f.byCode['1100'],credit:f.byCode['4000']}],
    ['/api/v1/transactions/disburse-loans',{user_id:f.users[0].id,debit:f.byCode['1100'],credit:f.byCode['1000'],amount:'1.00'}],
    ['/api/v1/transactions/payments',{user_id:f.users[0].id,entries:[{type:'BUY_SHARE',debit:f.byCode['1000'],credit:f.byCode['3000'],amount:'1.00'}]}],
    ['/api/v1/transactions/donations',{debit:f.byCode['1000'],credit:f.byCode['4300'],amount:'1.00'}],
    ['/api/v1/transactions/add-expense',{debit:f.byCode['5000'],credit:f.byCode['2000'],amount:'1.00',description:'expense'}],
    ['/api/v1/transactions/expenses/pay',{debit:f.byCode['2000'],credit:f.byCode['1000'],expenses:[{id:journals[0].id,amount:'1.00'}]}],
    ['/api/v1/loan-apply',{user_id:f.users[0].id,amount_desired:'1.00'}],
    ['/api/v1/loans/apply',{user_id:f.users[0].id,amount_desired:'1.00'}],
    ['/api/v1/me/loans/apply',{amount_desired:'1.00'}],
  ];
  for(const [route,body] of routes) {
    const response=await app({version:'2.0',rawPath:route,rawQueryString:'',headers:{authorization:'Bearer test','x-group-slug':f.group.slug,'content-type':'application/json'},requestContext:{http:{method:'POST',sourceIp:'127.0.0.1'}},body:JSON.stringify(body)},{});
    assert.equal(response.statusCode,409,`${route}: ${response.body}`);
  }
  const report=await f.invoke(new (require('../src/handlers/cycle-members'))(),'list');
  assert.equal(report.body.members.find(m=>m.id===f.users[0].id).remaining_loan,'0.00');
  const dashboard=await f.invoke(new (require('../src/handlers/dashboard'))(),'get');
  assert.equal(dashboard.body.outstanding_loans,'0.00');


  for(const code of ['1300','1400']) {
    const b=await fixture();await b.post('BUY_SHARE','100.00','1000','3000');await b.post('CHARGE','1.00',code,'4100');
    const r=await b.invoke();assert.equal(r.statusCode,409);assert.match(r.body.error,/contributions|penalties/);
    assert.equal((await db('cycles').where({id:b.cycle.id}).first()).status,'active');
    assert.equal((await db('cycle_distributions').where({cycle_id:b.cycle.id})).length,0);
  }
  const excess=await fixture();await excess.post('BUY_SHARE','100.00','1000','3000');await excess.post('BUY_SHARE','200.00','1000','3000',excess.users[1].id);await excess.post('LOAN_DISBURSED','150.00','1100','1000');
  const ex=await excess.invoke();assert.equal(ex.statusCode,200);assert.equal(ex.body.distributions[0].loan_deduction,'100.00');assert.equal(ex.body.distributions[0].net_amount,'0.00');assert.equal(await excess.balance('1100'),5000n);assert.deepEqual(ex.body.summary.warnings,['INSUFFICIENT_CASH']);
  const loss=await fixture();await loss.post('BUY_SHARE','100.00','1000','3000');await loss.post('EXPENSE','25.01','5000','1000',null);
  const lr=await loss.invoke();assert.equal(lr.statusCode,200);assert.equal(lr.body.summary.net_earnings,'-25.01');assert.equal(lr.body.summary.net_distribution,'74.99');assert.equal(await loss.balance('5000'),0n);
  const rollback=await fixture();await rollback.post('BUY_SHARE','100.00','1000','3000');await rollback.post('DONATION','1.00','1000','4300',null);
  await db.raw(`CREATE FUNCTION fail_distribution_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END $$; CREATE TRIGGER fail_distribution_test BEFORE INSERT ON cycle_distributions FOR EACH ROW EXECUTE FUNCTION fail_distribution_test()`);
  assert.equal((await rollback.invoke()).statusCode,409);
  assert.equal((await db('cycles').where({id:rollback.cycle.id}).first()).journal_voucher_counter,'0');
  assert.equal((await db('cycle_distribution_declarations').where({cycle_id:rollback.cycle.id})).length,0);
  assert.equal(await rollback.balance('4300'),-100n);assert.equal(await rollback.balance('3000'),-10000n);
  await db.raw('DROP TRIGGER fail_distribution_test ON cycle_distributions; DROP FUNCTION fail_distribution_test()');
});
