const crypto = require('node:crypto');
const PACKAGE_NAME = 'com.vebatech.tindamate';
const PRODUCT_ID = 'tindamate_pro_lifetime';
const APPLICATION_PUBLIC_KEY = 'jpm1AqOtA8sWpWqVk5cIcdbkYosItG8ExbAWXu1ceYo=';
class LicensingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function secretReference(arn) {
  if (typeof arn !== 'string' || !/^arn:aws(?:-us-gov|-cn)?:((?:secretsmanager)|ssm):[a-z0-9-]+:\d{12}:(?:secret:[A-Za-z0-9/_+=.@-]+|parameter\/[A-Za-z0-9/_.-]+)$/.test(arn)) throw Error();
  const service = arn.split(':')[2];
  if (!(service === 'ssm' ? arn.includes(':parameter/') : arn.includes(':secret:'))) throw Error();
  return service;
}
async function readSecret(arn) {
  const service = secretReference(arn);
  const options = { region: arn.split(':')[3], maxAttempts: 1 };
  const signal = AbortSignal.timeout(4000);
  if (service === 'ssm') {
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const client = new SSMClient(options);
    try {
      const result = await client.send(new GetParameterCommand({ Name: arn, WithDecryption: true }), { abortSignal: signal });
      if (result.Parameter?.Type !== 'SecureString') throw Error();
      return result.Parameter.Value;
    } finally { client.destroy(); }
  }
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient(options);
  try { return (await client.send(new GetSecretValueCommand({ SecretId: arn }), { abortSignal: signal })).SecretString; }
  finally { client.destroy(); }
}
async function config(env = process.env, dependencies = {}) {
  try {
    const key = name => {
      const value = env[name];
      if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error();
      const result = Buffer.from(value, 'base64');
      if (result.toString('base64') !== value) throw Error();
      return result;
    };
    const hashKey = key('TINDAMATE_TOKEN_HASH_KEY');
    const encryptionKey = key('TINDAMATE_TOKEN_ENCRYPTION_KEY');
    if (hashKey.equals(encryptionKey)) throw Error();
    const load = async prefix => {
      const arn = env[prefix + '_SECRET_ARN'];
      secretReference(arn);
      const value = await (dependencies.readSecret || readSecret)(arn);
      const field = env[prefix + '_SECRET_FIELD'];
      const selected = field ? JSON.parse(value)[field] : value;
      if (typeof selected !== 'string' || !selected) throw Error();
      return selected;
    };
    const pem = env.TINDAMATE_SIGNING_PRIVATE_KEY;
    if (typeof pem !== 'string' || !pem) throw Error();
    const privateKey = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw Error();
    const publicKey = crypto.createPublicKey(privateKey);
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    if (!raw.equals(Buffer.from(dependencies.expectedPublicKey || APPLICATION_PUBLIC_KEY, 'base64'))) throw Error();
    const credentialsText = await load('TINDAMATE_GOOGLE');
    const credentials = JSON.parse(credentialsText);
    if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw Error();
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    return { hashKey, encryptionKey, privateKey, publicKey, credentials,
      packageName: PACKAGE_NAME, productId: PRODUCT_ID,
      audience: env.TINDAMATE_PUBSUB_AUDIENCE, email: env.TINDAMATE_PUBSUB_EMAIL, subscription: env.TINDAMATE_PUBSUB_SUBSCRIPTION };
  } catch { throw new LicensingError(503, 'Licensing unavailable'); }
}
module.exports = { config, LicensingError, readSecret, secretReference, PACKAGE_NAME, PRODUCT_ID, APPLICATION_PUBLIC_KEY };
