const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { GoogleAdapter } = require('../src/services/tindamate/google');
const { PACKAGE_NAME, PRODUCT_ID } = require('../src/services/tindamate/config');
const verifyBody = { packageName: PACKAGE_NAME, productId: PRODUCT_ID, purchaseToken: 'test-token' };
const reconcileBody = { entitlementId: '41146f9a-53bb-4a2d-b868-ea70bb6e9a80' };
async function withServer(services, work) {
  const app = createApp(() => { throw Error('COMSCA database must not be touched'); }, services);
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
  try { await work('http://127.0.0.1:' + server.address().port); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('licensing routes isolated, bounded JSON, aliases, safe errors, no GET status', async () => {
  await withServer({ tindamate: { async verify() { return { status: 'PENDING' }; }, async reconcile() { throw Error('TOKEN_SECRET'); } } }, async base => {
    const path = base + '/api/v1/tindamate/licenses';
    for (const route of ['/verify', '/restore', '/v1/google-play/verify']) { const r = await fetch(path + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(verifyBody) }); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); }
    for (const route of ['/status', '/unknown']) assert.equal((await fetch(path + route)).status, 404);
    for (const body of ['{', '[]', 'null']) assert.equal((await fetch(path + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
    assert.equal((await fetch(path + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(17000) }) })).status, 413);
    const r = await fetch(path + '/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reconcileBody) }); assert.equal(r.status, 503); assert(!JSON.stringify(await r.json()).includes('TOKEN_SECRET'));
  });
});
test('unconfigured licensing does not initialize while serving other routes', async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(base + '/outside')).status, 404);
    assert.equal((await fetch(base + '/api/v1/tindamate/licenses/status')).status, 404);
    const r = await fetch(base + '/api/v1/tindamate/licenses/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(verifyBody) }); assert.equal(r.status, 503);
  });
});
test('OIDC signature client, audience, issuer and verified email required; unconfigured rejected', async () => {
  const config = { audience: 'https://example.test/rtdn', email: 'push@example.test', subscription: 'projects/test/subscriptions/one' };
  const adapter = new GoogleAdapter(config);
  const good = { iss: 'https://accounts.google.com', email: config.email, email_verified: true };
  let payload = good;
  adapter.oidc = { async verifyIdToken(options) { assert.equal(options.audience, config.audience); assert.equal(options.idToken, 'signed'); return { getPayload: () => payload }; } };
  await adapter.authenticate('Bearer signed');
  for (const bad of [{ ...good, iss: 'evil' }, { ...good, email: 'evil' }, { ...good, email_verified: false }]) { payload = bad; await assert.rejects(adapter.authenticate('Bearer signed'), /Unauthorized/); }
  adapter.oidc.verifyIdToken = async () => { throw Error('bad signature'); }; await assert.rejects(adapter.authenticate('Bearer signed'), /Unauthorized/);
  await assert.rejects(adapter.authenticate(''), /Unauthorized/);
  await assert.rejects(new GoogleAdapter({}).authenticate('Bearer signed'), /Webhook unavailable/);
});
