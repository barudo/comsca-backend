---
title: 'Void a transaction with reversing ledger postings'
type: 'feature'
created: '2026-10-24'
status: 'in-review'
route: 'dispatch'
baseline_commit: '8769b44d5ff150266c0c9024df76ca1e213400d9'
review_loop_iteration: 0
context: []
---

<frozen-after-approval>
## Intent

Add DELETE /api/v1/transactions/:transactionId to reverse a transaction's account effects and set its status to voided. Keep the transaction and its original entries available for inspection.

## Boundaries & Constraints

Always scope access and all writes to the authenticated request's group. Commit reversal postings and status together. Serialize concurrent void requests and prevent a second reversal. Preserve exact numeric precision and original document numbers.

Never physically delete transactions or original ledger records. Deployment and applying migrations to production are outside this change.

Confirmed decisions: append negative postings to original debit accounts and positive postings to original credit accounts. Only OWNER and ADMIN may void. Reject paid expenses with 409. Also reject linked expense-payment transactions with 409 to preserve settlement state; do not reopen expenses or alter allocations.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected behavior | Error handling |
|---|---|---|---|
| Void | Authorized actor, active transaction | Insert offsetting postings; return transaction with voided status | Atomic rollback on failure |
| Repeat | Already voided | No additional postings | Return existing voided transaction |
| Invalid ID | Not a positive PostgreSQL bigint | No writes | 400 |
| Missing | Missing transaction or another group's ID | No writes | 404 |
| Unauthorized | Actor outside allowed roles | No writes | 403 |
| Paid expense or linked expense payment | Existing settlement | No writes | 409 |
| Concurrent voids | Same transaction | At most one set of reversals | Lock and recheck status |

</frozen-after-approval>

## Code Map

- `src/routes/index.js`: authenticated group-scoped routes; register the new DELETE route.
- `src/handlers/transaction-entries.js`: group membership and positive bigint validation conventions.
- `src/handlers/payment-transactions.js`: debit-positive/credit-negative account entries and transactional writes.
- `migrations/018_scope_account_ledger.js`: deferred balance validator requires each component's positive and negative totals to equal its amount; appending reversals currently violates it.
- `migrations/021_validate_account_entries_after_changes.js`: child changes touch and lock parent headers after mutation.
- `migrations/031_add_entry_accounts_and_document_number_index.js`: debit/credit references can be null for legacy split postings; derive reversals from actual ledger postings.
- `migrations/032_add_transaction_status.js`: active/voided status already exists.
- `src/handlers/accounting-trial-balance.js`: balances aggregate signed account entries.
- `src/handlers/me-transactions.js`: member history already filters active headers.
- `src/handlers/expense-payments.js`: payment allocation and expense payment flags are separate from ledger status; this endpoint's requested scope is accounting reversal and transaction status.
- `test/account-ledger-migration.integration.test.js`: disposable PostgreSQL fixture and deferred-constraint test patterns.

## Tasks & Acceptance

**Execution:**
- [x] `migrations/036_support_transaction_voids.js`: add explicit reversal-to-original posting linkage with uniqueness and group/component/account/amount validation. Keep active transaction checks and require exact cancellation per original posting for voided transactions. Guard rollback when reversals exist.
- [x] `src/handlers/transactions.js`: implement authorization, ID validation, transactional locks, repeated-void handling, exact negation of original postings, and final status update. Follow cycle-before-header lock ordering used by existing payment operations where relevant.
- [x] `src/routes/index.js`: instantiate handler and register authenticated DELETE endpoint.
- [x] `src/handlers/cycle-members.js` and `src/handlers/dashboard.js`: exclude voided headers from metrics that sum component amounts rather than signed postings; add regression assertions to their existing tests.
- [x] `test/transactions.test.js`: test success, permissions, IDs, isolation, repeated requests, precision, and rollback.
- [x] `test/account-ledger-migration.integration.test.js`: verify real constraint acceptance, rejection of malformed reversals, legacy split postings, concurrency, and guarded rollback.

**Acceptance Criteria:**
- Given an active transaction with multiple components, when voided, then each affected account's net contribution from that transaction becomes zero and the header becomes voided in the same commit.
- Given an invalid or incomplete reversal, when committed, then database constraints reject it without losing the original ledger.
- Given concurrent or repeated DELETE requests, when completed, then the ledger contains exactly one reversal per original posting.
- Given unrelated transactions, when one transaction is voided, then their entries and statuses remain unchanged.

## Implementation Notes

- Resumed on 2026-10-24 at the user’s request to check and finish interrupted work. Preserve existing implementation and use minimal, focused tests only; do not run the full suite.

## Spec Change Log

## Review Triage Log

| Finding | Verdict and evidence | Resolution |
|---|---|---|
| Blind: interest reconstruction includes voided headers | high: `interests.js` reconstructs principal and interest from component amounts without checking header status. | Patch the event query to include active headers only. |
| Blind: coordinated SQL deletion of reversals and reactivation | false as an endpoint defect: no exposed handler performs either mutation; DELETE only appends reversals and sets voided. Permanent database immutability against privileged coordinated edits is not required by this endpoint. | Rejected. |
| Blind: coordinated SQL changes to original/reversal accounts | false as an endpoint defect: the handler never updates original postings; the database intentionally validates consistency rather than universal ledger immutability. | Rejected. |
| Blind: loan application remains inactive after void | false: the confirmed task reverses account effects and header status; loan applications retain their historical disbursement metadata and are not reopened. No requirement to restore application workflow state. | Rejected. |
| Blind: report tests do not execute active/voided filtering | medium: existing mocks check SQL text and database fixtures previously contained only active headers. | Patch existing focused database fixtures. |
| Blind: no void-versus-payment concurrency test | low: both handlers lock the cycle before headers; payment explicitly checks active/UNPAID after locking, while void checks PAID and payment links. No incorrect interleaving was identified. | Additional race testing omitted under the user's minimal-test instruction. |
| Verification: report fixtures lack voided transactions | medium: the database tests need an active/voided mixture to verify actual totals. | Same focused fixture patch as the blind finding. |

Edge-case reviewer reported no findings.

## Verification

- `node --test test/transactions.test.js test/cycle-member-balances.test.js test/dashboard.test.js`: all 12 handler, route, and metrics regression tests passed.
- `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres node --test --test-name-pattern='transaction voids' test/account-ledger-migration.integration.test.js`: passed the focused real PostgreSQL reversal constraints, precision, legacy split postings, concurrency, and guarded rollback test against a disposable PostgreSQL 16 container; container removed afterward.
- Full `npm test` intentionally omitted per the user’s minimal-test request.
- `git diff --check`: no whitespace errors.
