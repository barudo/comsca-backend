---
title: Match TindaMate mobile licensing contract
type: bugfix
created: 2026-11-06
status: in-progress
route: dispatch
review_loop_iteration: 0
baseline_commit: 4af899f72eafcc2119932e663030e37a51118227
context: []
---

<frozen-after-approval reason="User explicitly requested audit, minimal fixes, tests and examples; implementation authorized">

## Intent
Make existing backend licensing match the unchanged Android application: package `com.vebatech.tindamate`, product `tindamate_pro_lifetime`, verify by token and reconcile by UUID alone. Preserve strict detached Ed25519 canonical certificates and durable idempotency.

## Boundaries & Constraints
Never access, print, log, commit or generate a production private key. Runtime secret reads must use Secrets Manager or SSM SecureString, never plaintext private-key environment variables. The application's raw public key is `jpm1AqOtA8sWpWqVk5cIcdbkYosItG8ExbAWXu1ceYo=`; validate the loaded private key against it. Do not edit the app, deploy, or run production migrations. Preserve COMSCA routes and existing PostgreSQL storage; no DynamoDB rewrite. Keep aliases working. Production secret ARN/provider/optional JSON field are operator-supplied configuration, not invented facts: the user's placeholder does not identify an existing secret. Support either provider through exact ARN references. Runtime Play credentials must also come from a scoped secret reference. Existing hash/encryption keys remain stable.

## I/O & Edge-Case Matrix
| Scenario | Expected |
|---|---|
| Valid purchased non-consumable | Persist entitlement before acknowledgement; VERIFIED with payload and signature only |
| Same token repeated/concurrent | Same UUID and certificate on verify; one purchase record |
| Pending/canceled/refunded | PENDING/REVOKED without grant or acknowledgement |
| Invalid token or unknown UUID | HTTP 200 INVALID with generic message |
| Malformed input, wrong package/product, malformed UUID | HTTP 400 |
| Reconcile existing valid UUID without proof | Revalidate with Google; freshly sign current issuedAt, same UUID |
| Legacy package entitlement | INVALID; do not decrypt with new package AAD or grant cross-package access |
| Transient provider/secret/database/ack failures | HTTP 5xx; no fake success or revocation |
| Authenticated RTDN refund/void | Durable terminal revocation, duplicate-safe; no resurrection |
| Missing/incorrect signing key | Generic 503; no key material in error |
| Exact canonical bytes | Six ordered fields, no expiresAt; 64-byte detached signature verifies with TweetNaCl |
</frozen-after-approval>

## Code Map
- `src/services/tindamate/config.js`: synchronous plaintext env configuration, obsolete package; change to async secret loader with production public-key pinning.
- `cryptography.js`: already correct canonical JSON and Ed25519; remove keyId envelope, allow fresh reconcile timestamp, reject invalid/future timestamps. Package scopes HMAC/AAD: preserve old rows and reject cross-package reconciliation.
- `service.js`: reconcile requires certificate and returns 403 for unknown IDs; preserve acknowledgement ordering and lock flow while correcting contract.
- `google.js`: switch productsv2 to products.get, validate numeric state/acknowledgement, optional returned productId/token mismatches, non-consumption, quantity/refund evidence. Google resource permits omitted productId/token; URL scopes package/product.
- `repository.js`, migration `039`: unique hash and entitlement, session advisory lock, encrypted token; stop retaining order IDs/provider personal metadata. New migration changes package default without rewriting legacy package rows and removes obsolete metadata columns. Keep operational state/timestamps and RTDN dedupe necessary for reliability.
- `src/routes/tindamate-licenses.js`: lazy initialization must await/cache config promise and retry on failure; validate request before secret load; generic errors.
- `serverless.yml`: shared Lambda httpApi wildcard, no gateway throttles or secret-read IAM; do not break unrelated routes. PostgreSQL table privileges are database grants, not AWS IAM.
- `test/tindamate*.test.js`: mock Google and repository; optional real database suite.

## Tasks & Acceptance
- [ ] Config/secrets: use official AWS SDK secret reads, bounded calls, reject SSM plaintext parameters; env contains only secret ARN and optional field names. Validate Ed25519 and pinned raw public key, normalize PEM newlines; fail closed without sensitive errors. Unit-test through injected fake readers and throwaway keys (production expected public key cannot be overridden via environment).
- [ ] Service/routes/crypto: exact response/request schemas; strict UUID; INVALID messages; fresh reconcile certificate and stable verify certificate. Return stored terminal revocation even when Google unavailable. Preserve no-store and input size bounds.
- [ ] Google/repository/migration: products.get and robust RTDN revalidation, unique persistence and durable acknowledgement retry, remove order_id metadata, explicitly scope new inserts to new package. Do not migrate token hashes or ciphertext across packages.
- [ ] Infrastructure: declare explicit licensing HTTP routes including aliases/RTDN, scoped gateway route throttling and exact-resource read IAM for secret references. Document existing shared database role limitation and dedicated least-privilege database grants; do not claim AWS IAM limits PostgreSQL tables. No broad secret resource wildcards.
- [ ] Tests/dependencies: add TweetNaCl interoperability using disposable keys, assert exact literal canonical JSON, 64-byte signature, negative verification with fixed application public key; test runtime public-key mismatch and secret errors. Positive verification against fixed app public key requires an actual production-signed fixture and cannot be fabricated from a throwaway key. Cover every matrix row, Google URL, route statuses, secret caching/retry, metadata minimization.
- [ ] `docs/tindamate-licensing.md`, `.env.example`: audit mismatches/fixes, both curl examples and exact response shape; secret setup with explicit unresolved actual ARN, permissions, migration/deploy steps, no app changes. Mark runtime deployment/key matching unverified.

**Acceptance Criteria:**
- Given existing COMSCA behavior, when the full suite runs, then no regressions occur.
- Given a valid app request, when mocked purchase verification succeeds, then response has exactly the app's fields and interoperable signature.
- Given absent runtime secret references, when licensing initializes, then it fails safely and unrelated routes still work.

## Implementation Notes
User authorization covers implementation and review; no additional approval gate for reversible local edits. Exact deployed secret identifier remains required for live configuration, but independent code and tests proceed using configurable references. Pending grants no entitlement, as required by the status contract. No live calls or secrets are needed for tests. Use only sanitized fake fixtures. Do not touch sibling app repository.

## Spec Change Log

## Review Triage Log

## Verification
Run focused TindaMate tests and full `npm test`; run PostgreSQL integration only on an explicit disposable test database. Inspect full diff and independent review. Do not deploy or apply production migrations. Validate generated Serverless configuration using fake secret ARNs, never production values, and avoid saving rendered private values.
