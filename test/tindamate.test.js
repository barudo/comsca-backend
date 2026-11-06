const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const { LicensingService } = require('../src/services/tindamate/service');
const { GoogleAdapter, validatePurchase } = require('../src/services/tindamate/google');
const { config: loadConfig, PACKAGE_NAME, PRODUCT_ID, APPLICATION_PUBLIC_KEY } = require('../src/services/tindamate/config');
const { canonical, createCrypto } = require('../src/services/tindamate/cryptography');
const keys = crypto.generateKeyPairSync('ed25519');
const config = { ...keys, hashKey: crypto.randomBytes(32), encryptionKey: crypto.randomBytes(32), packageName: PACKAGE_NAME, productId: PRODUCT_ID, subscription: 'projects/test/subscriptions/rtdn' };
function fixture(issuedAt) {
  let purchase, entitlement, queue = Promise.resolve(); const events = new Set();
  const repository = {
    async withLock(_hash, work) { const previous = queue; let release; queue = new Promise(resolve => release = resolve); await previous; try { return await work({}); } finally { release(); } },
    async findToken(_session, hash) { return purchase?.token_hash === hash ? purchase : undefined; },
    async persist(_session, hash, encrypted, state) {
      if (repository.fail) throw Error('transaction failed');
      const status = ['REVOKED', 'REFUNDED'].includes(purchase?.status) ? purchase.status : state.status;
      purchase = { id: 'purchase', token_hash: hash, encrypted_token: encrypted, package_name: config.packageName, product_id: config.productId, ...purchase, status,
        acknowledgement_status: state.acknowledged ? 'ACKNOWLEDGED' : purchase?.acknowledgement_status || 'PENDING' };
      if (status === 'VERIFIED' && !entitlement) entitlement = { id: crypto.randomUUID(), issued_at: issuedAt || new Date().toISOString() };
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
const good = () => ({ productId: config.productId, purchaseToken: body.purchaseToken, purchaseState: 0, acknowledgementState: 0, consumptionState: 0, quantity: 1, refundableQuantity: 1 });
test('lazy config rejects missing keys with safe error', async () => assert.rejects(loadConfig({}), /Licensing unavailable/));
test('config loads the environment signing key and pins its public key', async () => {
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const credentials = JSON.stringify({ type: 'service_account', client_email: 'publisher@example.test', private_key: privatePem });
  const googleArn = 'arn:aws:ssm:ap-southeast-1:123456789012:parameter/tindamate/google';
  const rawPublicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const env = {
    TINDAMATE_TOKEN_HASH_KEY: crypto.randomBytes(32).toString('base64'),
    TINDAMATE_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    TINDAMATE_SIGNING_PRIVATE_KEY: privatePem,
    TINDAMATE_GOOGLE_SECRET_ARN: googleArn,
    TINDAMATE_GOOGLE_SECRET_FIELD: 'credentials',
  };
  const reads = [];
  const readSecret = async arn => { reads.push(arn); return JSON.stringify({ credentials }); };
  for (const pem of [privatePem, privatePem.replace(/\n/g, '\\n')]) {
    const loaded = await loadConfig({ ...env, TINDAMATE_SIGNING_PRIVATE_KEY: pem }, {
      readSecret, expectedPublicKey: rawPublicKey,
    });
    assert.equal(loaded.packageName, PACKAGE_NAME);
    assert.equal(loaded.productId, PRODUCT_ID);
    assert.equal(loaded.credentials.client_email, 'publisher@example.test');
    const certificate = createCrypto(loaded).certificate({ id: crypto.randomUUID(), issued_at: new Date().toISOString() });
    assert(nacl.sign.detached.verify(Buffer.from(canonical(certificate.payload)), Buffer.from(certificate.signature, 'base64'), rawPublicKey));
  }
  assert.deepEqual(reads, [googleArn, googleArn]);
  const dependencies = { readSecret, expectedPublicKey: rawPublicKey };
  for (const invalidKey of [undefined, '', 'not-a-private-key']) {
    await assert.rejects(loadConfig({ ...env, TINDAMATE_SIGNING_PRIVATE_KEY: invalidKey }, dependencies),
      error => error.status === 503 && error.message === 'Licensing unavailable');
  }
  const wrongKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(loadConfig({ ...env, TINDAMATE_SIGNING_PRIVATE_KEY: wrongKey }, dependencies), /Licensing unavailable/);
  await assert.rejects(loadConfig({ ...env, TINDAMATE_TOKEN_ENCRYPTION_KEY: env.TINDAMATE_TOKEN_HASH_KEY }, dependencies), /Licensing unavailable/);
  await assert.rejects(loadConfig(env, { readSecret }), /Licensing unavailable/);
  await assert.rejects(loadConfig(env, {
    readSecret: async () => { throw Error('sensitive provider error'); },
    expectedPublicKey: rawPublicKey,
  }), error => error.status === 503 && error.message === 'Licensing unavailable');
});
test('detached certificate matches literal canonical JSON and TweetNaCl', () => {
  const c = createCrypto(config).certificate({
    id: '41146f9a-53bb-4a2d-b868-ea70bb6e9a80',
    issued_at: '2026-01-02T03:04:05.000Z',
  });
  const expected = '{"certificateVersion":1,"entitlementId":"41146f9a-53bb-4a2d-b868-ea70bb6e9a80","issuedAt":"2026-01-02T03:04:05.000Z","plan":"PRO","productId":"tindamate_pro_lifetime","source":"GOOGLE_PLAY"}';
  assert.equal(canonical(c.payload), expected);
  assert.deepEqual(Object.keys(c), ['payload', 'signature']);
  assert.deepEqual(Object.keys(c.payload), ['certificateVersion', 'entitlementId', 'issuedAt', 'plan', 'productId', 'source']);
  const message = Buffer.from(expected, 'utf8');
  const signature = Buffer.from(c.signature, 'base64');
  const rawPublicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.equal(signature.length, nacl.sign.signatureLength);
  assert.equal(nacl.sign.detached.verify(message, signature, rawPublicKey), true);
  assert.equal(nacl.sign.detached.verify(message, signature, Buffer.from(APPLICATION_PUBLIC_KEY, 'base64')), false);
  assert.equal(nacl.sign.detached.verify(Buffer.from(expected + ' '), signature, rawPublicKey), false);
});
test('certificate signing rejects invalid and future issuance times', () => {
  const signer = createCrypto(config);
  const id = '41146f9a-53bb-4a2d-b868-ea70bb6e9a80';
  assert.throws(() => signer.certificate({ id, issued_at: 'invalid' }), /Invalid certificate timestamp/);
  assert.throws(() => signer.certificate({ id, issued_at: new Date(Date.now() + 60000) }), /Invalid certificate timestamp/);
});
test('Google promo without order id, pending, cancellation, refund and invalid product', () => {
  assert.equal(validatePurchase(good(), config, body.purchaseToken).status, 'VERIFIED');
  for (const [state, expected] of [[2, 'PENDING'], [1, 'REVOKED']]) { const d = good(); d.purchaseState = state; assert.equal(validatePurchase(d, config, body.purchaseToken).status, expected); }
  const refund = good(); refund.refundableQuantity = 0; assert.equal(validatePurchase(refund, config, body.purchaseToken).status, 'REFUNDED');
  const wrong = good(); wrong.productId = 'other'; assert.equal(validatePurchase(wrong, config, body.purchaseToken).status, 'INVALID');
});
test('malformed provider response never grants or revokes', () => {
  for (const change of [d => delete d.purchaseState, d => d.purchaseState = 3, d => d.acknowledgementState = 2, d => d.consumptionState = 2, d => d.refundableQuantity = -1]) { const d = good(); change(d); assert.throws(() => validatePurchase(d, config, body.purchaseToken), /Invalid purchase provider response/); }
  const consumed = good(); consumed.consumptionState = 1; assert.equal(validatePurchase(consumed, config, body.purchaseToken).status, 'INVALID');
});
test('Google lookup and acknowledgement use the product-scoped API', async () => {
  const adapter = new GoogleAdapter(config);
  const requests = [];
  adapter.auth = { async request(options) { requests.push(options); return { data: good() }; } };
  assert.equal((await adapter.lookup(body.purchaseToken)).status, 'VERIFIED');
  await adapter.acknowledge(body.purchaseToken);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/products/${PRODUCT_ID}/tokens/${body.purchaseToken}`;
  assert.equal(requests[0].url, url);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[1].url, `${url}:acknowledge`);
  assert.equal(requests[1].method, 'POST');
});
test('same token concurrency returns stable certificate; raw public key verifies canonical mobile format', async () => {
  const f = fixture(); const results = await Promise.all(Array.from({ length: 12 }, () => f.service.verify(body)));
  assert.equal(new Set(results.map(r => JSON.stringify(r.certificate))).size, 1); assert.equal(f.google.acks, 1);
  const c = results[0].certificate; assert.equal(c.payload.expiresAt, undefined);
  assert.deepEqual(Object.keys(c), ['payload', 'signature']);
  assert.equal(Buffer.from(c.signature, 'base64').length, 64);
  assert.equal(canonical(c.payload), JSON.stringify({
    certificateVersion: 1,
    entitlementId: c.payload.entitlementId,
    issuedAt: c.payload.issuedAt,
    plan: 'PRO',
    productId: config.productId,
    source: 'GOOGLE_PLAY',
  }));
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const reconstructed = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, Buffer.from(canonical(c.payload)), reconstructed, Buffer.from(c.signature, 'base64')));
  assert.equal((await f.service.reconcile({ packageName: config.packageName, entitlementId: c.payload.entitlementId })).status, 'VERIFIED');
  assert.equal((await f.service.reconcile({ packageName: config.packageName, entitlementId: crypto.randomUUID() })).status, 'INVALID');
});
test('reconciliation issues a fresh certificate with the same entitlement', async () => {
  const f = fixture('2026-01-02T03:04:05.000Z');
  const first = await f.service.verify(body);
  const initialTimestamp = first.certificate.payload.issuedAt;
  const reconciled = await f.service.reconcile({ packageName: config.packageName, entitlementId: first.certificate.payload.entitlementId });
  assert.equal(reconciled.status, 'VERIFIED');
  assert.equal(reconciled.certificate.payload.entitlementId, first.certificate.payload.entitlementId);
  assert(Date.parse(reconciled.certificate.payload.issuedAt) > Date.parse(initialTimestamp));
  assert(Date.parse(reconciled.certificate.payload.issuedAt) <= Date.now());
  assert(f.service.crypto.valid(reconciled.certificate));
});
test('pending and invalid never acknowledge; package scope enforced', async () => {
  const f = fixture(); for (const status of ['PENDING', 'INVALID']) { f.google.state = { status }; assert.equal((await f.service.verify(body)).status, status); } assert.equal(f.google.acks, 0);
  await assert.rejects(f.service.verify({ ...body, packageName: 'other' }), /Invalid request/);
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
  for (const status of ['REVOKED', 'REFUNDED']) {
    const f = fixture();
    const verified = await f.service.verify(body);
    f.google.state = { status };
    const request = { packageName: config.packageName, entitlementId: verified.certificate.payload.entitlementId };
    assert.equal((await f.service.reconcile(request)).status, 'REVOKED');
    f.google.state = { status: 'VERIFIED' };
    assert.equal((await f.service.verify(body)).status, 'REVOKED');
    assert.equal((await f.service.reconcile(request)).status, 'REVOKED');
  }
});
test('reconciliation validates UUID; encrypted token authenticated', async () => {
  const f = fixture();
  await assert.rejects(f.service.reconcile({ packageName: config.packageName, entitlementId: 'not-a-uuid' }), /Invalid request/);
  await assert.rejects(f.service.reconcile({ entitlementId: crypto.randomUUID() }), /Invalid request/);
  await assert.rejects(f.service.reconcile({ packageName: 'other', entitlementId: crypto.randomUUID() }), /Invalid request/);
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
