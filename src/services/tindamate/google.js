const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { LicensingError } = require('./config');
function validatePurchase(data, config, token) {
  const malformed = () => { throw new LicensingError(502, 'Invalid purchase provider response'); };
  if (!data || typeof data !== 'object' || ![0, 1, 2].includes(data.purchaseState) || ![0, 1].includes(data.acknowledgementState) || ![0, 1].includes(data.consumptionState)) return malformed();
  if ((data.productId !== undefined && data.productId !== config.productId) || (data.purchaseToken !== undefined && data.purchaseToken !== token)) return { status: 'INVALID' };
  if (data.consumptionState !== 0) return { status: 'INVALID' };
  if (data.quantity !== undefined && data.quantity !== 1) return malformed();
  if (data.refundableQuantity !== undefined && ![0, 1].includes(data.refundableQuantity)) return malformed();
  const acknowledged = data.acknowledgementState === 1;
  if (data.purchaseState === 1) return { status: 'REVOKED', acknowledged };
  if (data.purchaseState === 2) return { status: 'PENDING', acknowledged };
  return { status: data.refundableQuantity === 0 ? 'REFUNDED' : 'VERIFIED', acknowledged };
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
    const data = await this.request(`purchases/products/${encodeURIComponent(this.config.productId)}/tokens/${encodeURIComponent(token)}`);
    return data === null ? { status: 'INVALID' } : validatePurchase(data, this.config, token);
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
