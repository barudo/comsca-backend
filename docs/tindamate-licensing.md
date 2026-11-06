# TindaMate Google Play licensing

The licensing API is an isolated Express router in the existing Node.js 20 Lambda. It uses the existing PostgreSQL database and does not require COMSCA authentication. The current mobile contract is package `com.vebatech.tindamate` and product `tindamate_pro_lifetime`.

This feature is optional: unrelated API routes do not initialize licensing configuration. Licensing requests return a safe `503` until its required keys and secret references are configured. This document describes the code and deployment prerequisites; it does not mean production secrets, AWS permissions, database migrations, or a Lambda deployment have been configured or verified.

## API

All endpoints are `POST`, require `Content-Type: application/json`, and return `Cache-Control: no-store`.

| Endpoint | Purpose |
|---|---|
| `/api/v1/tindamate/licenses/verify` | Verify a Google Play purchase |
| `/api/v1/tindamate/licenses/restore` | Alias for verification |
| `/api/v1/tindamate/licenses/v1/google-play/verify` | Mobile-client verification alias |
| `/api/v1/tindamate/licenses/reconcile` | Re-check a previously issued entitlement |
| `/api/v1/tindamate/licenses/v1/google-play/reconcile` | Mobile-client reconciliation alias |
| `/api/v1/tindamate/licenses/rtdn` | Receive authenticated Google Play RTDN push messages |

Verification request (replace the base URL and token with test values):

```sh
curl -X POST 'https://<api-host>/api/v1/tindamate/licenses/verify' \
  -H 'Content-Type: application/json' \
  --data '{"packageName":"com.vebatech.tindamate","productId":"tindamate_pro_lifetime","purchaseToken":"<Google Play purchase token>"}'
```

Reconciliation request (use the entitlement ID returned by verification):

```sh
curl -X POST 'https://<api-host>/api/v1/tindamate/licenses/reconcile' \
  -H 'Content-Type: application/json' \
  --data '{"packageName":"com.vebatech.tindamate","entitlementId":"<UUID>"}'
```

For a verified purchase, either endpoint returns HTTP 200 with:

```json
{
  "status": "VERIFIED",
  "certificate": {
    "payload": {
      "certificateVersion": 1,
      "entitlementId": "<UUID>",
      "issuedAt": "<ISO-8601 UTC timestamp>",
      "plan": "PRO",
      "productId": "tindamate_pro_lifetime",
      "source": "GOOGLE_PLAY"
    },
    "signature": "<base64 detached Ed25519 signature>"
  }
}
```

Other HTTP 200 responses are `{"status":"PENDING"}`, `{"status":"REVOKED"}`, and `{"status":"INVALID","message":"License not found or invalid"}`. Malformed requests return 4xx. Provider, database, secret, and acknowledgement failures return 5xx rather than success-shaped fallbacks. Acknowledgement is retried on later verification requests if the first attempt fails.

Reconciliation revalidates the stored purchase with Google, but it does not authenticate the caller or require purchase proof: anyone who knows a valid entitlement UUID can request a fresh certificate. Treat the UUID as a bearer credential and protect it. The API cannot prevent sharing across users or devices without an additional identity or proof mechanism.

Certificates contain `payload` and `signature`. The Ed25519 signature is detached base64 over UTF-8 `JSON.stringify` output with these payload keys in this exact order:

1. `certificateVersion` (`1`)
2. `entitlementId`
3. `issuedAt` (UTC ISO-8601)
4. `plan` (`PRO`)
5. `productId`
6. `source` (`GOOGLE_PLAY`)

There is no expiry field. Reconciliation checks current purchase state with Google and reissues the certificate with a fresh `issuedAt`; offline clients cannot learn about a refund until they reconcile online. The mobile app must verify the signature using its pinned 32-byte raw Ed25519 public key.

## Runtime configuration

Set the variables in the deployment environment consumed by Serverless. The signing private key, hash key, and encryption key are Lambda environment variables; Google credentials are read from Secrets Manager or SSM SecureString. Restrict access to the Lambda configuration, deployment environment, CloudFormation artifacts, and the KMS keys protecting them. Never print, commit, or share private key material.

| Variable | Required | Meaning |
|---|---:|---|
| `TINDAMATE_TOKEN_HASH_KEY` | Yes | Base64 encoding of exactly 32 random bytes; stable HMAC key for purchase-token lookup |
| `TINDAMATE_TOKEN_ENCRYPTION_KEY` | Yes | Base64 encoding of a different 32 random bytes; stable AES-256-GCM key for stored purchase tokens |
| `TINDAMATE_SIGNING_PRIVATE_KEY` | Yes | Ed25519 private-key PEM with actual or escaped newline characters |
| `TINDAMATE_GOOGLE_SECRET_ARN` | Yes | Exact Secrets Manager or SSM ARN containing Google Play service-account JSON |
| `TINDAMATE_GOOGLE_SECRET_FIELD` | No | Property name if the Google secret is a JSON object; leave empty for direct service-account JSON |
| `TINDAMATE_PUBSUB_AUDIENCE` | For RTDN | Exact OIDC audience configured on the Pub/Sub push subscription |
| `TINDAMATE_PUBSUB_EMAIL` | For RTDN | Email of the service account used for authenticated push |
| `TINDAMATE_PUBSUB_SUBSCRIPTION` | For RTDN | Exact subscription resource name, e.g. `projects/<project>/subscriptions/<name>` |
| `TINDAMATE_SECRETS_KMS_KEY_ARN` | If applicable | Exact customer-managed KMS key ARN used to decrypt the Google credential secret |

The signing key is checked at startup against the mobile app's pinned public key. A mismatch fails closed with `503`; do not replace the pinned key or generate a new production signer without coordinating a mobile key rotation.

**Deployment warning:** Serverless resolves `TINDAMATE_SIGNING_PRIVATE_KEY` from the deployment process environment. A key set only in the Lambda console is not automatically read by Serverless. If the deployment variable is absent, the configured empty default can replace the existing Lambda value and licensing will return `503`. Securely supply the same key to the deployment process before deploying; never paste it into a command, logs, source control, or chat. The resolved key can be present in rendered CloudFormation templates, deployment artifacts, and infrastructure state; protect and clean up those artifacts according to your security policies. Alternatively, manage the Lambda environment using an approved deployment process that preserves the key. A console-only key does not take effect in this source code until the updated code is deployed. The production key's match with the mobile app has not been verified.

Generate hash and encryption keys separately in a secure operator environment (for example, generate 32 random bytes and base64-encode each). Keep both stable: changing the hash key makes existing purchases unfindable, and changing the encryption key prevents reconciliation from decrypting stored tokens. Key rotation requires a planned data migration and should not be done by simply changing environment values.

The Lambda execution role needs `secretsmanager:GetSecretValue` or `ssm:GetParameter` on the exact Google credential secret ARN. For a customer-managed KMS key, grant `kms:Decrypt` on that exact key and ensure the key policy also permits the Lambda role. The Serverless template conditionally adds these scoped policies; the AWS account, region, secret ARN, KMS key, and resulting deployed role still need operator verification. The AWS SDK v3 clients are declared application dependencies and packaged with the Lambda.

The Google service account must have the Google Play Developer API access required to read one-time product purchases and acknowledge them. For RTDN, configure Pub/Sub push authentication with the specified service account and audience, then set the exact subscription name above. Without those three RTDN settings, the webhook is intentionally unavailable.

## Database and deployment

Apply migrations `039_create_tindamate_licensing.js` and `040_tindamate_mobile_contract.js` to the intended PostgreSQL database before enabling licensing traffic. They create isolated licensing tables with row-level security and update the package default; they do not migrate legacy package purchases into the new package. Migration `040` drops deprecated purchase metadata columns. Its rollback recreates those columns empty and cannot restore values already removed.

Deploy with the repository's normal Serverless process after reviewing the rendered CloudFormation template, secret ARNs, IAM policies, API Gateway route throttles, and the Lambda environment. Do not run deployment or production migration commands until the operator has supplied and verified the target account, region, database, and secret references. The route-level limiter is in-process; API Gateway throttles are the cross-instance protection.

AWS IAM controls access to the secret services, not PostgreSQL tables. The migration enables row-level security and revokes direct grants from the named client roles, but PostgreSQL table ownership or a superuser connection can bypass row-level security. Verify which database role the Lambda actually uses and grant only the required licensing-table privileges to that role; do not assume the Lambda IAM policy restricts SQL access.

For local development, provide fake/test-only keys and test secrets. The config unit test injects a fake secret reader and throwaway signing key; it does not call AWS or require production key material. Do not use production credentials or a production database in tests. The optional PostgreSQL integration test runs only when `TEST_DATABASE_URL` is explicitly supplied and creates a separate random-named database.

## Validation and operational notes

Run the focused checks with:

```sh
node --test test/tindamate.test.js test/tindamate-routes.test.js test/tindamate.integration.test.js
```

The integration test is skipped unless `TEST_DATABASE_URL` is set. Run the broader repository suite with `npm test` to check for regressions.

This change has not been deployed or verified against live AWS, Google Play, Pub/Sub, or production PostgreSQL. Before enabling it, verify the secret key matches the app-pinned public key, exercise purchase/acknowledgement and refund flows with Play test purchases, and confirm the API Gateway and Lambda configuration in the target account.
