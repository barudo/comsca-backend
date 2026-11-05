const { LicensingError, config: loadConfig } = require('./config');
const { createCrypto } = require('./cryptography');
const { Repository, terminal } = require('./repository');
const { GoogleAdapter } = require('./google');
const bad = () => { throw new LicensingError(400, 'Invalid request'); };
const tokenValid = token => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token);
class LicensingService {
  constructor(config, repository, google) { this.config = config; this.repository = repository; this.google = google; this.crypto = createCrypto(config); }
  async verify(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !tokenValid(body.purchaseToken)) return bad();
    if (body.packageName !== this.config.packageName || body.productId !== this.config.productId) return { status: 'INVALID' };
    return this.process(body.purchaseToken);
  }
  async process(token, event) {
    const hash = this.crypto.hash(token);
    return this.repository.withLock(hash, async session => {
      if (event && await this.repository.hasEvent(session, event.key)) return { received: true };
      const state = await this.google.lookup(token);
      if (state.status === 'INVALID') {
        if (event) throw new LicensingError(503, 'Purchase evidence unavailable');
        return { status: 'INVALID' };
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
      return { status: 'VERIFIED', certificate: this.crypto.certificate(entitlement) };
    });
  }
  async reconcile(body) {
    if (!body || body.packageName !== this.config.packageName || !this.crypto.valid(body.certificate) || body.entitlementId !== body.certificate.payload.entitlementId) {
      throw new LicensingError(403, 'Invalid reconciliation proof');
    }
    const purchase = await this.repository.findEntitlement(body.entitlementId);
    if (!purchase) throw new LicensingError(403, 'Invalid reconciliation proof');
    return this.process(this.crypto.decrypt(purchase.encrypted_token));
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
function createService(db) { const config = loadConfig(); return new LicensingService(config, new Repository(db), new GoogleAdapter(config)); }
module.exports = { LicensingService, createService };
