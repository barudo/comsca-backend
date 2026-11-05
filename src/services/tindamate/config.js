const crypto = require('node:crypto');
class LicensingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function config(env = process.env) {
  try {
    const key = name => {
      const value = env[name];
      if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error();
      return Buffer.from(value, 'base64');
    };
    const hashKey = key('TINDAMATE_TOKEN_HASH_KEY');
    const encryptionKey = key('TINDAMATE_TOKEN_ENCRYPTION_KEY');
    if (hashKey.equals(encryptionKey)) throw Error();
    const privateKey = crypto.createPrivateKey(env.TINDAMATE_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw Error();
    const credentials = JSON.parse(env.TINDAMATE_GOOGLE_CREDENTIALS);
    if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw Error();
    return { hashKey, encryptionKey, privateKey, publicKey: crypto.createPublicKey(privateKey), credentials,
      keyId: env.TINDAMATE_SIGNING_KEY_ID || 'v1', packageName: 'com.mobilepos.scanner', productId: 'tindamate_pro_lifetime',
      audience: env.TINDAMATE_PUBSUB_AUDIENCE, email: env.TINDAMATE_PUBSUB_EMAIL, subscription: env.TINDAMATE_PUBSUB_SUBSCRIPTION };
  } catch { throw new LicensingError(503, 'Licensing unavailable'); }
}
module.exports = { config, LicensingError };
