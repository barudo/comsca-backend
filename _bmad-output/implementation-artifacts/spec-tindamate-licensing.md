---
title: TindaMate lifetime PRO licensing
type: feature
created: 2026-11-05
status: in-progress
route: dispatch
review_loop_iteration: 0
baseline_commit: ecfdf84f79ba00141f1b230d264c94090d27ee14
context: []
---

<frozen-after-approval reason="Implementation explicitly authorized in user request">

## Intent
Implement secure lifetime Google Play PRO licensing inside the existing Lambda backend, isolated from COMSCA. Deliver migrations, verification, signed certificates, restoration, authenticated RTDN reconciliation, tests and deployment documentation without deploying or accessing production data.

## Boundaries & Constraints
Use CommonJS Express/Knex and existing database; no new framework or COMSCA auth/business changes. Package com.mobilepos.scanner and product tindamate_pro_lifetime are configured backend values. No subscriptions, expiration, custom promo codes, accounts or device binding. Tokens are bearer credentials: cannot prevent sharing across identities when no identity exists. Require proof for reconciliation; signed certificate is the default proposed to the user (small mobile change), never expose licenses from UUID alone. No production secrets generated. Keep all errors and logs free of tokens/credentials.

## I/O & Edge-Case Matrix
| Scenario | Result |
|---|---|
| Completed purchase incl. promo with no order ID | Verify Google, persist logical entitlement, acknowledge if needed, return VERIFIED certificate |
| Pending | PENDING, no certificate or acknowledgement |
| Invalid token/product/package | INVALID safe failure; no grant |
| Unknown/malformed Google response or transient error | HTTP 502/503, no grant or false revocation |
| Confirmed cancellation/refund | Persist REVOKED/REFUNDED, revoke entitlement, return REVOKED |
| Duplicate/concurrent verify or restore | One purchase and entitlement, stable certificate timestamp/UUID |
| Acknowledgement failure | Durable retry state, HTTP 503; later request retries safely |
| Transaction failure | No partially committed entitlement or success response |
| Missing/tampered reconciliation proof | Reject without revealing purchase information |
| Duplicate/out-of-order RTDN | Authenticated, authoritative Google lookup, idempotent transaction; terminal revocation never resurrects |
</frozen-after-approval>

## Code Map
- src/handler.js wraps src/app.js via serverless-http; app rejects paths outside /api/v1.
- src/routes/index.js mounts public routes before COMSCA group/auth middleware. Mount isolated licensing router before group middleware, with its own catchall.
- src/db.js and knexfile.js share PostgreSQL pool max 2. Migrations numbered through 038; node --test framework; optional disposable PostgreSQL integration uses TEST_DATABASE_URL.
- serverless.yml deploys Node20 Lambda httpApi wildcard; environment placeholders and packaging exclusions. scripts/production.js loads deployment environment; do not execute it.
- ../pos/docs/google-play-billing.md and ../pos/src/services/{play-billing.service,entitlement-certificate}.ts reviewed. Client appends /v1/google-play/verify and /reconcile to configured base URL, sends packageName/productId/purchaseToken for verify, packageName/entitlementId only for reconcile. No user auth. Return status VERIFIED/PENDING/REVOKED/INVALID; non-2xx retains local PRO.
- Certificate signature: Ed25519 detached base64 over JSON exact key order certificateVersion, entitlementId, issuedAt, plan, productId, source. Version 1, PRO, GOOGLE_PLAY; raw 32-byte public key base64. Keep key identifier outside signed payload. Preserve original issuedAt.

## Tasks & Acceptance
- [ ] migrations/039_create_tindamate_licensing.js: up/down isolated purchases, entitlements, events; UUIDs, unique keyed token hash and purchase FK, status checks, timestamps, encrypted token, acknowledgement retry state, RTDN dedupe key. Enable RLS with no client grants; no COMSCA FK.
- [ ] src/services/tindamate/: config, cryptography, official maintained Google client adapter, transactional repository and licensing service. Lazy config so unconfigured licensing cannot break COMSCA. Support environment secrets; no Secrets Manager dependency necessary if environment configuration documented. Separate HMAC and AES-256-GCM keys, authenticated ciphertext, Ed25519 PEM validation. Google productsv2 authoritative response validation, configured package scope, product/state/completion/ack state; non-consumable only. Refund detection via authoritative refundableQuantity when supplied and cancelled state; authenticated voided notifications must re-query and retry if evidence not yet visible. Never trust notification state alone. Persist before acknowledgement; serialize concurrent processing and retry safely, bounded Google timeouts, avoid rollback losing ack-failure evidence.
- [ ] src/routes/tindamate-licenses.js and src/routes/index.js: strict limited JSON, safe errors/no-store, namespace /api/v1/tindamate/licenses with verify/restore/reconcile/rtdn. Client aliases /v1/google-play/verify and /reconcile relative to namespace, configure client base to namespace. Omit GET status. Require signed certificate for reconcile and authoritative revalidation using encrypted stored token. Verify Pub/Sub OIDC signature/issuer/audience/verified email and configured subscription before handling; reject unconfigured webhook. Add supported rate limiting with clear Lambda limitations; HTTPS via API Gateway.
- [ ] .env.example, serverless.yml, package.json/lock: configuration/dependencies, isolated environment forwarding with empty defaults, no broad IAM or changes to existing routes. Official google-auth-library or googleapis maintained integration; no custom JWT implementation.
- [ ] test/tindamate*.test.js: mocked Google cases for every matrix row, certificate tampering and signature verification, route isolation, bad JSON/request/auth, same-token concurrency, RTDN duplicates, retry, rollback; actual migration constraints if local disposable PostgreSQL is available. Never use DATABASE_URL or production DB for tests.
- [ ] docs/tindamate-licensing.md: API examples, exact signing format/public-key extraction, mobile reconciliation patch needed, Google API/service-account/Play permissions, Pub/Sub topic and OIDC push setup, environment/secrets/IAM instructions, deployment and rollback, encrypted key rotation and HMAC stability, rate limits, acknowledgement retry operations, operational limitations, test results. Link official sources; distinguish implemented from live-configured.

**Acceptance Criteria:**
- Given existing COMSCA tests, when npm test runs, then functionality remains unchanged (report existing skips/failures accurately).
- Given client verification format, when a completed Google purchase is verified, then certificate verifies with existing mobile canonical Ed25519 algorithm and has no expiration.
- Given unconfigured licensing, when COMSCA handles requests, then no licensing config is required.
- Given an offline certificate, when revoked remotely, then docs explicitly state offline access persists until online reconciliation and secure client integration is required.

## Implementation Notes
User explicitly authorized implementation after concise plan; proceed without an additional plan approval gate. Proposed reconciliation proof is signed certificate; do not edit sibling mobile repository. No external deployment or migrations authorized. Public Google docs inspected: productsv2 purchaseStateContext.purchaseState PURCHASED/PENDING/CANCELLED, productLineItem[].productId/productOfferDetails.refundableQuantity, purchaseCompletionTime, ACKNOWLEDGEMENT_STATE_PENDING/ACKNOWLEDGED. Promo orderId may be absent. Use current official references for adapter details.

## Spec Change Log

## Review Triage Log

## Verification
Run focused node tests and npm test. Where possible use only a newly created disposable local PostgreSQL test database. Verify all changes in diff and independent review; do not commit/deploy.

Original-request detail retained for implementation: table names are tindamate_google_play_purchases, tindamate_entitlements, tindamate_license_events. Purchases include product_id/package_name/purchase_token_hash/order_id/purchase_state/acknowledgement_state/status/purchased_at/last_verified_at/revoked_at plus timestamps; entitlements include plan/status/issued_at/revoked_at. Events include event_type and sanitized JSONB event_data for verification/acknowledgement/issuance/restoration/refund/revocation/failure, as well as RTDN deduplication. Shared database session settings must not leak to COMSCA; session advisory locks require direct/session PostgreSQL connectivity rather than transaction pooling.
