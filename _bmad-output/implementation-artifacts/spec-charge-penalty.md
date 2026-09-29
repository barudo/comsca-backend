---
title: 'Charge penalties for enrolled cycle members'
type: 'feature'
created: '2026-09-29'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The API has no dedicated endpoint to charge cycle members a penalty while recording the charge in their balances and the accounting ledger.

**Approach:** Add `POST /api/v1/penalties/charge` accepting a positive per-member amount and selected debit/credit account IDs. Apply it to every member enrolled in the current cycle, creating a `PENALTY` transaction, `CHARGE_PENALTY` entries, and balanced account postings atomically.

</frozen-after-approval>

## Implementation Notes

- Reused contribution-charge semantics: current non-closed cycle, all enrolled members, and per-member amount.
- Added a dedicated penalty handler, route, request tests, and API documentation; debit and credit are restricted to accounts 1300 and 4100.
- Added a PostgreSQL integration case for persisted entries/postings and atomic rollback; it requires `TEST_DATABASE_URL` to execute.

## Review Triage Log

- low — Replaced chart codes in the request example with illustrative account row IDs and clarified that 1300/4100 are codes.
- false — Draft cycles can use existing group-scoped accounts, which the ledger permits for cycle activity; documented that cycle defaults are seeded on activation.
- low — Documented endpoint status codes and no-partial-write behavior for rejected charges.
- low — Documented the per-member decimal bound and aggregate `numeric(18,2)` limit.
- low, rejected — An arbitrary roster cap would diverge from the established contribution-charge endpoint, which batches inserts and returns the full roster; no response contract change was requested.
- low — Added a database-backed success and rollback test; execution remains unverified here because `TEST_DATABASE_URL` is unset.
