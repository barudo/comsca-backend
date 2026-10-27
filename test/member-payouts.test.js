const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/handlers/member-payouts');
const valid = { user_id: 1, credit: '2', amount: '001.20', idempotency_key: ' key ' };
test('payout validation normalizes IDs and cents without changing the key', () => {
  assert.deepEqual(parse(valid), {user_id:'1',credit:'2',amount:'1.20',idempotency_key:' key '});
  assert.equal(parse({...valid,amount:'9999999999999999.99'}).amount,'9999999999999999.99');
});
test('payout validation rejects malformed, unknown, overflowing and nonpositive inputs', () => {
  const invalid=[null,[],{}, {...valid,debit:'3'}];
  for(const user_id of [null,0,-1,'01','1.2','9223372036854775808',Number.MAX_SAFE_INTEGER+1]) invalid.push({...valid,user_id});
  for(const credit of [null,{},0,'foreign']) invalid.push({...valid,credit});
  for(const amount of [null,{},true,0,-1,'-1','1.001','1e2','NaN',Infinity,'10000000000000000.00',1000000000001]) invalid.push({...valid,amount});
  for(const idempotency_key of [null,1,'','\n','a\n','é','a'.repeat(129)]) invalid.push({...valid,idempotency_key});
  for(const input of invalid) assert.throws(()=>parse(input),error=>error.status===400,JSON.stringify(input));
});
