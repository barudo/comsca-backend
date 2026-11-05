const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { LicensingError } = require('./config');
function validatePurchase(data, config) {
  const malformed = () => { throw new LicensingError(502, 'Invalid purchase provider response'); };
  if (!data || !Array.isArray(data.productLineItem) || data.productLineItem.length !== 1) return malformed();
  const item = data.productLineItem[0];
  if (typeof item?.productId !== 'string') return malformed();
  if (item.productId !== config.productId) return { status: 'INVALID' };
  const state = data.purchaseStateContext?.purchaseState;
  if (!['PURCHASED', 'PENDING', 'CANCELLED'].includes(state)) return malformed();
  if (!['ACKNOWLEDGEMENT_STATE_PENDING', 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(data.acknowledgementState)) return malformed();
  const offer = item.productOfferDetails || {};
  if (offer.rentOfferDetails || offer.preorderOfferDetails) return { status: 'INVALID' };
  if (offer.quantity !== undefined && offer.quantity !== 1) return malformed();
  if (offer.refundableQuantity !== undefined && ![0, 1].includes(offer.refundableQuantity)) return malformed();
  if (offer.consumptionState !== undefined && offer.consumptionState !== 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED') return malformed();
  const acknowledged = data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  const metadata = { purchaseState: state, orderId: typeof data.orderId === 'string' ? data.orderId : null, purchasedAt: typeof data.purchaseCompletionTime === 'string' && Number.isFinite(Date.parse(data.purchaseCompletionTime)) ? data.purchaseCompletionTime : null };
  if (state === 'CANCELLED') return { status: 'REVOKED', acknowledged, ...metadata };
  if (state === 'PENDING') return { status: 'PENDING', acknowledged, ...metadata };
  if (typeof data.purchaseCompletionTime !== 'string' || !Number.isFinite(Date.parse(data.purchaseCompletionTime))) return malformed();
  return { status: offer.refundableQuantity === 0 ? 'REFUNDED' : 'VERIFIED', acknowledged, ...metadata };
}
class GoogleAdapter {
  constructor(config) {
    this.config = config;
    this.auth = new GoogleAuth({ credentials: config.credentials, clientOptions: { transporterOptions: { timeout: 4000, retry: false } }, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    this.oidc = new OAuth2Client({ transporterOptions: { timeout: 4000, retry: false } });
  }
  async request(path, method = 'GET') {
    try {
      return (await this.auth.request({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${this.config.packageName}/${path}`,
        method, ...(method === 'POST' ? { data: {} } : {}), timeout: 4000, retry: false })).data;
    } catch (error) {
      if (method === 'GET' && [400, 404, 410].includes(error.response?.status)) return null;
      throw new LicensingError(503, 'Purchase provider unavailable');
    }
  }
  async lookup(token) {
    const data = await this.request(`purchases/productsv2/tokens/${encodeURIComponent(token)}`);
    return data === null ? { status: 'INVALID' } : validatePurchase(data, this.config);
  }
  async acknowledge(token) {
    await this.request(`purchases/products/${this.config.productId}/tokens/${encodeURIComponent(token)}:acknowledge`, 'POST');
  }
  async authenticate(header) {
    const { audience, email, subscription } = this.config;
    if (!audience || !email || !subscription) throw new LicensingError(503, 'Webhook unavailable');
    if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw new LicensingError(401, 'Unauthorized');
    try {
      const ticket = await this.oidc.verifyIdToken({ idToken: header.slice(7), audience });
      const payload = ticket.getPayload();
      if (!payload || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) || payload.email !== email || payload.email_verified !== true) throw Error();
    } catch { throw new LicensingError(401, 'Unauthorized'); }
  }
}
module.exports = { GoogleAdapter, validatePurchase };
