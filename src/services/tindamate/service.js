const { LicensingError, config: loadConfig, PACKAGE_NAME, PRODUCT_ID } = require('./config');
const { createCrypto } = require('./cryptography');
const { Repository, terminal } = require('./repository');
const { GoogleAdapter, validateVoidedPurchase } = require('./google');
const bad = () => { throw new LicensingError(400, 'Invalid request'); };
const tokenValid = token => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token);
const uuidValid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const invalid = () => ({ status: 'INVALID', message: 'License not found or invalid' });
function validateRequest(method, body, packageName = PACKAGE_NAME, productId = PRODUCT_ID) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad();
  if (method === 'verify' && (!tokenValid(body.purchaseToken) || body.packageName !== packageName || body.productId !== productId)) return bad();
  if (method === 'reconcile' && (!uuidValid(body.entitlementId) || body.packageName !== packageName)) return bad();
}
class LicensingService {
  constructor(config, repository, google) { this.config = config; this.repository = repository; this.google = google; this.crypto = createCrypto(config); }
  async verify(body) {
    validateRequest('verify', body, this.config.packageName, this.config.productId);
    return this.process(body.purchaseToken);
  }
  async process(token, event, fresh = false) {
    const hash = this.crypto.hash(token);
    return this.repository.withLock(hash, async session => {
      if (event && await this.repository.hasEvent(session, event.key)) return { received: true };
      const stored = await this.repository.findToken(session, hash);
      if (stored && terminal(stored.status)) {
        if (event) { await this.repository.event(session, event.key, stored.id); return { received: true }; }
        return { status: 'REVOKED' };
      }
      const state = await this.google.lookup(token);
      if (state.status === 'INVALID') {
        if (event) throw new LicensingError(503, 'Purchase evidence unavailable');
        return invalid();
      }
      if (event?.voided && !terminal(state.status)) throw new LicensingError(503, 'Purchase evidence unavailable');
      const { purchase, entitlement } = await this.repository.persist(session, hash, this.crypto.encrypt(token), state);
      if (purchase.status === 'VERIFIED' && purchase.acknowledgement_status !== 'ACKNOWLEDGED') {
        let succeeded = false;
        try { await this.google.acknowledge(token); succeeded = true; } catch { /* Durable retry below; never expose provider errors. */ }
        await this.repository.ack(session, purchase.id, succeeded);
        if (!succeeded) throw new LicensingError(503, 'Purchase acknowledgement pending; retry');
      }
      if (event) { await this.repository.event(session, event.key, purchase.id); return { received: true }; }
      if (terminal(purchase.status)) return { status: 'REVOKED' };
      if (purchase.status === 'PENDING') return { status: 'PENDING' };
      return { status: 'VERIFIED', certificate: this.crypto.certificate(entitlement, fresh ? new Date() : entitlement.issued_at) };
    });
  }
  async reconcile(body) {
    validateRequest('reconcile', body, this.config.packageName, this.config.productId);
    const purchase = await this.repository.findEntitlement(body.entitlementId);
    if (!purchase || purchase.package_name !== this.config.packageName || purchase.product_id !== this.config.productId) return invalid();
    if (terminal(purchase.status)) return { status: 'REVOKED' };
    return this.process(this.crypto.decrypt(purchase.encrypted_token), undefined, true);
  }

  async sweepVoidedPurchases() {
    let processed = 0;
    for await (const item of this.google.voidedPurchases()) {
      const state = validateVoidedPurchase(item);
      const hash = this.crypto.hash(item.purchaseToken);
      await this.repository.withLock(hash, async session => {
        const stored = await this.repository.findToken(session, hash);
        if (!stored || !terminal(stored.status)) {
          await this.repository.persist(session, hash, this.crypto.encrypt(item.purchaseToken), state);
        }
      });
      processed++;
    }
    return { processed };
  }

  async rtdn(body, header) {
    await this.google.authenticate(header);
    if (body?.subscription !== this.config.subscription || typeof body?.message?.messageId !== 'string' || body.message.messageId.length > 256 || !body.message.messageId || typeof body.message.data !== 'string') return bad();
    let notification;
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.message.data)) return bad();
      notification = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'));
    } catch { return bad(); }
    if (notification?.packageName !== this.config.packageName) return bad();
    if (notification.testNotification) return { received: true };
    const purchase = notification.oneTimeProductNotification || notification.voidedPurchaseNotification;
    if (!purchase || !tokenValid(purchase.purchaseToken)) return bad();
    if (notification.oneTimeProductNotification && (purchase.sku !== this.config.productId || ![1, 2].includes(purchase.notificationType))) return bad();
    if (notification.voidedPurchaseNotification && purchase.productType !== 2) return bad();
    return this.process(purchase.purchaseToken, { key: this.config.subscription + ':' + body.message.messageId, voided: Boolean(notification.voidedPurchaseNotification) });
  }
}
async function createService(db) { const config = await loadConfig(); return new LicensingService(config, new Repository(db, config), new GoogleAdapter(config)); }
module.exports = { LicensingService, createService, validateRequest };
