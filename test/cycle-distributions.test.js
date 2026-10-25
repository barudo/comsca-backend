const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allocate, cents, decimal, analyzeLedger } = require('../src/services/cycle-distributions');
test('allocations reconcile cents deterministically for profit and loss without floating point', () => {
  const capital = new Map([['3', 100n], ['1', 100n], ['2', 100n]]);
  assert.deepEqual([...allocate(2n, capital)], [['1', 1n], ['2', 1n], ['3', 0n]]);
  assert.deepEqual([...allocate(-2n, capital)], [['1', -1n], ['2', -1n], ['3', 0n]]);
  assert.equal(decimal(cents('-9007199254740993.99')), '-9007199254740993.99');
  assert.throws(() => allocate(1n, new Map()), /capital/);
  assert.throws(() => allocate(-301n, capital), /Losses/);
  for (let amount = -300n; amount <= 300n; amount++) {
    const result = allocate(amount, capital);
    assert.equal([...result.values()].reduce((a,b) => a+b, 0n), amount);
    assert.ok([...result].every(([id, value]) => capital.get(id)+value>=0n));
  }
});
test('ledger rejects missing equity identity, negative loans, and member debts hidden by netting', () => {
  const row = (type, code, amount, user_id = '1', component_type = 'BUY_SHARE') => ({ type, code, amount, user_id, component_type, account_id: code, account_cycle_id: '1', cycle_id: '1' });
  const base = [row('ASSET','1000','100.00'), row('EQUITY','3000','-100.00')];
  const members = [{user_id:'1'},{user_id:'2'}];
  assert.equal(analyzeLedger(members,base).capital.get('1'),10000n);
  assert.throws(() => analyzeLedger(members,[base[0], {...base[1],user_id:null}]), /attribution/);
  assert.throws(() => analyzeLedger(members,[...base,row('ASSET','1400','5.00'),row('ASSET','1400','-5.00','2')]), /contributions/);
  assert.throws(() => analyzeLedger(members,[...base,row('ASSET','1100','-5.00'),row('ASSET','1000','5.00')]), /Negative loan/);
});
