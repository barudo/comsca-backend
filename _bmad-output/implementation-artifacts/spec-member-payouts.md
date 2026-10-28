---
title: 'Record and retrieve member payouts'
type: 'feature'
created: '2026-10-28'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '9c87ae26e0162795a8d7a83f88c40b8c46accd59'
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent">

## Intent

**Problem:** Cycles can declare member proceeds but cannot record cash payouts or retrieve payout history.

**Approach:** Add POST and GET `/api/v1/cycles/:cycleId/payouts`. The user explicitly delegates endpoint selection and implementation. POST records a single payment toward one member's declared entitlement, only while the cycle is distributing. GET returns recorded payments for the selected cycle, including after closure.

## Boundaries & Constraints

**Always:** Authenticate and scope all records to the selected group. Follow existing financial-role access: OWNER/ADMIN/TREASURER write; those roles plus AUDITOR read. Use integer cents and decimal strings. POST accepts `user_id`, `credit` (cash funding account ID), `amount`, and required `idempotency_key` (1–128 printable ASCII characters). Derive the debit payable from the declaration. Support partial and full payouts, never overpayment. A retry with the same key and normalized payload returns the original payout without a second posting; conflicting reuse returns 409. New payments return 201, replay 200. Reject writes in any cycle status other than distributing, including retries after closing. GET remains readable for any existing cycle and returns an empty list before payouts exist. Preserve declared amounts and audit history; only paid amount, payment status, and updated timestamp may change. Never apply migrations to the user's configured or production database during this task.

**Never:** Reuse loan-disbursement semantics, permit arbitrary debit accounts, pay from receivable accounts, modify declaration snapshots, implement payout voiding or residual-loan collection, or change existing closing eligibility.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Payment | Distributing cycle, declared member, positive amount <= remaining entitlement and cash | Balanced MEMBER_PAYOUT journal using DISBURSEMENT_VOUCHER, immutable payout row, updated paid amount/status | 201 |
| Retry | Same cycle/key and same normalized payload | Original payout returned; no extra postings/counter changes | 200; conflicting payload 409 |
| Invalid input | Invalid IDs, unknown fields, invalid key, zero/negative/excess precision/overflow amount | No mutation | 400 |
| Lifecycle | Draft, active, closed cycle POST | No mutation | 409 |
| Access/scope | Unauthorized role or foreign/missing cycle/member/account | No disclosure or mutation | 403 or 404 |
| Balances | Overpayment, insufficient cash, invalid funding/payable classification | No mutation | 409 or 400 |
| Concurrent writes/failure | Concurrent retries or overpayment attempts; injected insert failure | At most available entitlement/cash paid; failure rolls back journal/counter/payment state | Conflict or replay; atomic rollback |
| Read | Existing cycle and authorized role | 200 with cycle and payouts in deterministic ID order; historical closed reads work | Missing cycle 404 |

</frozen-after-approval>

## Code Map

- `src/routes/index.js`: register handler instance and authenticated routes near cycle distributions.
- `src/handlers/expense-payments.js`: role checks, positive money/ID validation, funding sum, voucher transaction conventions; reuse patterns without loan or expense semantics.
- `src/handlers/cycle-distributions.js`: read transaction isolation, restricted group-reader role and group setting.
- `src/services/cycle-distributions.js`: cents/decimal and retrieve summary. Stored summary total_paid is currently zero; derive current total_paid from distribution rows after payout support. Keep declaration-time cash/shortfall snapshot semantics documented.
- `migrations/037_create_cycle_distributions.js`: immutable declaration/member triggers, pending-only status and paid=0 check require new migration. Do not edit 037. Transaction type regex accepts MEMBER_PAYOUT; voucher type already supported.
- `test/cycle-distributions.integration.test.js`: disposable database fixture applying real migrations, roles and cross-group assertions. PostgreSQL binaries available locally for isolated test instance.
- `docs/cycle-distributions.md`, `README.md`: update old unsupported-payout statements and document endpoints.

## Tasks & Acceptance

**Execution:**
- [x] `migrations/038_create_member_payouts.js` -- introduce payout audit table, group RLS/read grants, composite group/cycle/member/transaction/account foreign keys, unique cycle/key constraint and positive amount checks. Add controlled paid-state updates while protecting all entitlement fields; retain immutable payout rows. Guard downgrade against loss of payout data and restore prior checks/triggers when empty.
- [x] `src/handlers/member-payouts.js` -- implement strict validation and transactional create/list. Lock cycle before checking status, replay and balances, then distribution and accounts. Scope member by declared distribution. Cash must be same-cycle ASSET with explicit CASH role or unclassified code 1000, never known receivable codes. Validate stored payable as same-cycle LIABILITY/DISTRIBUTION_PAYABLE. Atomic journal, entries, postings, payout row and paid-state update; status pending/partial/paid. Return success, payout, updated distribution and transaction on write; success, cycle, payouts on GET.
- [x] `src/routes/index.js`, `src/services/cycle-distributions.js` -- wire routes and update live total_paid in retrieval.
- [x] `test/member-payouts.test.js`, `test/member-payouts.integration.test.js` -- exercise matrix through handler/HTTP and real PostgreSQL constraints, including isolation, idempotency, concurrency and rollback. Verify ledger cash/payable totals and unchanged declaration amounts.
- [x] `docs/cycle-distributions.md`, `README.md` -- explain request/response, permissions, partial payments, replay rules, lifecycle and migration requirement.

**Acceptance Criteria:**
- Given a declared cycle, when partial then final payouts occur, then paid amounts and statuses reconcile with cash/payable postings and distribution retrieval reports current total_paid.
- Given historical immutable declarations, when the migration runs, then amounts remain intact and payouts become recordable without permitting entitlement changes or deletion.
- Given authenticated HTTP requests, when either route is used, then routing and group isolation work consistently with the existing API.

## Implementation Notes

User's explicit instruction to suggest and implement authorizes proceeding through the skill's planning checkpoint. No unresolved intent gaps; endpoint contract choices delegated. New migration file is reversible locally and is not applied to existing environments. Footprint is one migration, one handler, route/service updates, docs and tests. If implementation evidence reveals a contract gap, report it rather than silently expanding scope.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence / disposition |
|---|---|---|
| Blind: payout insert without progress update | low | Direct owner SQL can bypass reconciliation by omitting the progress update, but the only application payout writer performs both atomically. No API path commits this state. Additional database-owner misuse protection rejected as low likelihood and extra trigger complexity. |
| Blind: initial nonzero paid state | low | Direct owner inserts can create inconsistent progress; declaration service always inserts zero/pending and no API accepts distribution records. Additional privileged-SQL protection rejected as low likelihood and added complexity. |
| Blind: actor identity absent from payout | low | Recipient and transaction identity are retained; authenticated operator attribution is an optional audit enhancement, not a failure of payout or history behavior. Rejected because it adds schema/API surface beyond the payment contract without a demonstrated incorrect result. |
| Blind: upgrade of existing declarations untested | medium | Patched test downgrades a populated declaration with no payouts, reapplies 038, checks unchanged declarations/entitlements, then pays it successfully. |
| Blind: successful empty-history rollback untested | medium | Patched test verifies rollback with unpaid declarations, immutable trigger restoration and reapplication. |
| Blind: HTTP success and replay untested | medium | Patched authenticated HTTP creation/replay test verifies 201/200, matching payout ID and exactly two postings. |
| Blind: account classification branches untested | medium | Patched explicit custom CASH success, unclassified custom rejection, CASH-tagged receivable rejection and invalid payable rejection. |
| Verification: explicit CASH funding eligibility unverified | medium | Same test gap as above; fixed and executed successfully against PostgreSQL 17. |

Edge-case reviewer returned no findings. All three independent review layers completed. Implementation agent became unavailable due to a usage limit; parent completed the patches and verification.

## Verification

- Run targeted payout and distribution tests with TEST_DATABASE_URL pointing only to a newly initialized temporary local PostgreSQL instance.
- Run `npm test`; confirm existing tests pass and report environment-dependent skips.
- Inspect full diff and run `git diff --check`.

### Completed verification

- Targeted payout and distribution tests: 7 passed, 0 failed, 0 skipped, including real PostgreSQL 17 accounting, concurrency, rollback, RLS and migration checks in a disposable Docker container.
- Full `npm test`: 191 passed, 13 failed, 8 skipped. Verified the same 13 donation/expense failures on baseline revision in an isolated checkout (189 passed, 13 failed, 7 skipped); no new suite failures.
- `git diff --check` passed. Configured and production databases were not changed.
- Parent completed documentation, write-role locking and test corrections after the implementation subagent stopped. User committed initial implementation as c92ca25 while this work was ongoing; preserved that commit.
