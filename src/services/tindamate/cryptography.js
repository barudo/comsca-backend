const crypto = require('node:crypto');
function canonical(c) {
  return JSON.stringify({ certificateVersion: c.certificateVersion, entitlementId: c.entitlementId,
    issuedAt: c.issuedAt, plan: c.plan, productId: c.productId, source: c.source });
}
function createCrypto(config) {
  return {
    hash(token) { return crypto.createHmac('sha256', config.hashKey).update(config.packageName + '\0' + token).digest('hex'); },
    encrypt(token) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
      cipher.setAAD(Buffer.from(config.packageName));
      const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    },
    decrypt(value) {
      const [version, iv, tag, data] = value.split('.');
      if (version !== 'v1') throw Error('Unsupported encryption version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(config.packageName)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
    certificate(entitlement, issuedAt = entitlement.issued_at) {
      const timestamp = new Date(issuedAt);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > Date.now()) throw Error('Invalid certificate timestamp');
      const payload = { certificateVersion: 1, entitlementId: entitlement.id,
        issuedAt: timestamp.toISOString(), plan: 'PRO', productId: config.productId, source: 'GOOGLE_PLAY' };
      return { payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), config.privateKey).toString('base64') };
    },
    valid(certificate) {
      try {
        const c = certificate?.payload;
        return c && c.certificateVersion === 1 && c.plan === 'PRO' && c.productId === config.productId && c.source === 'GOOGLE_PLAY' &&
          typeof c.entitlementId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.entitlementId) && typeof c.issuedAt === 'string' &&
          Number.isFinite(Date.parse(c.issuedAt)) && new Date(c.issuedAt).toISOString() === c.issuedAt && Date.parse(c.issuedAt) <= Date.now() &&
          typeof certificate.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(certificate.signature) && crypto.verify(null, Buffer.from(canonical(c)), config.publicKey, Buffer.from(certificate.signature, 'base64'));
      } catch { return false; }
    },
  };
}
module.exports = { createCrypto, canonical };
