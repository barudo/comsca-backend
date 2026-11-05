const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LicensingService } = require('../src/services/tindamate/service');
const { validatePurchase } = require('../src/services/tindamate/google');
const { config: loadConfig } = require('../src/services/tindamate/config');
const { canonical } = require('../src/services/tindamate/cryptography');
const keys = crypto.generateKeyPairSync('ed25519');
const config = { ...keys, hashKey: crypto.randomBytes(32), encryptionKey: crypto.randomBytes(32), packageName: 'com.mobilepos.scanner', productId: 'tindamate_pro_lifetime', keyId: 'test', subscription: 'projects/test/subscriptions/rtdn' };
function fixture() {
  let purchase, entitlement, queue = Promise.resolve(); const events = new Set();
  const repository = {
    async withLock(_hash, work) { const previous = queue; let release; queue = new Promise(resolve => release = resolve); await previous; try { return await work({}); } finally { release(); } },
    async persist(_session, hash, encrypted, state) {
      if (repository.fail) throw Error('transaction failed');
      const status = ['REVOKED', 'REFUNDED'].includes(purchase?.status) ? purchase.status : state.status;
      purchase = { id: 'purchase', token_hash: hash, encrypted_token: encrypted, ...purchase, status,
        acknowledgement_status: state.acknowledged ? 'ACKNOWLEDGED' : purchase?.acknowledgement_status || 'PENDING' };
      if (status === 'VERIFIED' && !entitlement) entitlement = { id: crypto.randomUUID(), issued_at: new Date().toISOString() };
      return { purchase, entitlement };
    },
    async ack(_session, _id, succeeded) { purchase.acknowledgement_status = succeeded ? 'ACKNOWLEDGED' : 'RETRY'; },
    async findEntitlement(id) { return id === entitlement?.id ? purchase : undefined; },
    async hasEvent(_s, key) { return events.has(key); }, async event(_s, key) { events.add(key); },
  };
  const google = { state: { status: 'VERIFIED', acknowledged: false }, calls: 0, acks: 0,
    async lookup() { this.calls++; if (this.error) throw this.error; return this.state; },
    async acknowledge() { this.acks++; if (this.failAck) throw Error('SECRET token credentials'); }, async authenticate(header) { if (header !== 'Bearer good') throw Error('unauthorized'); } };
  return { service: new LicensingService(config, repository, google), repository, google, purchase: () => purchase, events };
}
const body = { packageName: config.packageName, productId: config.productId, purchaseToken: 'secret-token' };
const good = () => ({ productLineItem: [{ productId: config.productId, productOfferDetails: { quantity: 1, refundableQuantity: 1, consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED' } }], purchaseStateContext: { purchaseState: 'PURCHASED' }, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', purchaseCompletionTime: '2026-01-01T00:00:00Z' });
test('lazy config rejects missing keys with safe error', () => assert.throws(() => loadConfig({}), /Licensing unavailable/));
test('Google promo without order id, pending, cancellation, refund and invalid product', () => {
  assert.equal(validatePurchase(good(), config).status, 'VERIFIED');
  for (const [state, expected] of [['PENDING', 'PENDING'], ['CANCELLED', 'REVOKED']]) { const d = good(); d.purchaseStateContext.purchaseState = state; delete d.purchaseCompletionTime; assert.equal(validatePurchase(d, config).status, expected); }
  const refund = good(); refund.productLineItem[0].productOfferDetails.refundableQuantity = 0; assert.equal(validatePurchase(refund, config).status, 'REFUNDED');
  const wrong = good(); wrong.productLineItem[0].productId = 'other'; assert.equal(validatePurchase(wrong, config).status, 'INVALID');
});
test('malformed provider response never grants or revokes', () => {
  for (const change of [d => delete d.purchaseCompletionTime, d => d.purchaseStateContext.purchaseState = 'UNKNOWN', d => d.acknowledgementState = 'UNKNOWN', d => d.productLineItem = [], d => d.productLineItem[0].productOfferDetails.refundableQuantity = -1, d => d.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED']) { const d = good(); change(d); assert.throws(() => validatePurchase(d, config), /Invalid purchase provider response/); }
});
test('same token concurrency returns stable certificate; raw public key verifies canonical mobile format', async () => {
  const f = fixture(); const results = await Promise.all(Array.from({ length: 12 }, () => f.service.verify(body)));
  assert.equal(new Set(results.map(r => JSON.stringify(r.certificate))).size, 1); assert.equal(f.google.acks, 1);
  const c = results[0].certificate; assert.equal(c.payload.expiresAt, undefined);
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const reconstructed = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, Buffer.from(canonical(c.payload)), reconstructed, Buffer.from(c.signature, 'base64')));
  assert.equal((await f.service.reconcile({ packageName: config.packageName, entitlementId: c.payload.entitlementId, certificate: c })).status, 'VERIFIED');
  c.payload.plan = 'FREE'; await assert.rejects(f.service.reconcile({ packageName: config.packageName, entitlementId: c.payload.entitlementId, certificate: c }), /proof/);
});
test('pending and invalid never acknowledge; package scope enforced', async () => {
  const f = fixture(); for (const status of ['PENDING', 'INVALID']) { f.google.state = { status }; assert.deepEqual(await f.service.verify(body), { status }); } assert.equal(f.google.acks, 0);
  assert.equal((await f.service.verify({ ...body, packageName: 'other' })).status, 'INVALID');
  await assert.rejects(f.service.verify({ ...body, purchaseToken: '' }), /Invalid request/);
});
test('ack failure durable, retry succeeds and preserves entitlement', async () => {
  const f = fixture(); f.google.failAck = true; await assert.rejects(f.service.verify(body), /acknowledgement pending/);
  assert.equal(f.purchase().acknowledgement_status, 'RETRY'); f.google.failAck = false;
  assert.equal((await f.service.verify(body)).status, 'VERIFIED'); assert.equal(f.google.acks, 2);
});
test('transaction and upstream failures never produce success or acknowledge', async () => {
  const f = fixture(); f.repository.fail = true; await assert.rejects(f.service.verify(body)); assert.equal(f.purchase(), undefined); assert.equal(f.google.acks, 0);
  f.repository.fail = false; f.google.error = Error('transient'); await assert.rejects(f.service.verify(body)); assert.equal(f.purchase(), undefined);
});
test('revocation is terminal even after stale purchased result', async () => {
  for (const status of ['REVOKED', 'REFUNDED']) { const f = fixture(); await f.service.verify(body); f.google.state = { status }; assert.equal((await f.service.verify(body)).status, 'REVOKED'); f.google.state = { status: 'VERIFIED' }; assert.equal((await f.service.verify(body)).status, 'REVOKED'); }
});
test('proof mandatory; encrypted token authenticated', async () => {
  const f = fixture(); await assert.rejects(f.service.reconcile({ entitlementId: crypto.randomUUID() }), /proof/);
  const encrypted = f.service.crypto.encrypt('secret'); assert.equal(f.service.crypto.decrypt(encrypted), 'secret');
  const parts = encrypted.split('.'); parts[3] = Buffer.from('tamper').toString('base64'); assert.throws(() => f.service.crypto.decrypt(parts.join('.')));
});
test('authenticated RTDN duplicate, delayed void evidence and retry', async () => {
  const f = fixture(); const notification = { packageName: config.packageName, voidedPurchaseNotification: { purchaseToken: body.purchaseToken, productType: 2 } };
  const envelope = { subscription: config.subscription, message: { messageId: 'one', data: Buffer.from(JSON.stringify(notification)).toString('base64') } };
  await assert.rejects(f.service.rtdn(envelope, 'bad')); assert.equal(f.google.calls, 0);
  await assert.rejects(f.service.rtdn(envelope, 'Bearer good'), /evidence/); assert.equal(f.events.size, 0);
  f.google.state = { status: 'REFUNDED' }; await f.service.rtdn(envelope, 'Bearer good'); const calls = f.google.calls;
  await f.service.rtdn(envelope, 'Bearer good'); assert.equal(f.google.calls, calls); assert.equal(f.events.size, 1);
  await assert.rejects(f.service.rtdn({ ...envelope, subscription: 'wrong' }, 'Bearer good'));
});
