---
title: 'Pay multiple expenses in full'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement POST /api/v1/transactions/expenses/pay with expenses [{id, amount}], debit and credit. Full payments only: verify each submitted amount against the original expense without reducing that original amount. Pay active UNPAID expenses, record balanced accounting entries and links, allocate one disbursement voucher, and update expense_payment_status to PAID atomically. Reject duplicate, already paid, unknown-status, or out-of-scope expenses and insufficient funding. No subagent testing.

</frozen-after-approval>

## Implementation Notes

- Current writable cycle, group membership, financial-writer role and account scopes follow existing financial endpoint conventions. Batch size 1–100 matches bounded payment endpoint patterns.
- Lock current cycle then expense rows in ID order. Validate debit against the full original negative ledger postings and check credit ASSET balance after locks.
- One payment header/component records the total; two account postings balance it. Migration 035 adds expense_payments with exact amounts, unique per-expense links, group/cycle foreign keys, RLS, and guarded rollback.
- Inputs normalize decimal strings/numeric IDs and use bigint cents; no floating-point money calculations.
- Added request tests for atomic failures, authorization, malformed/duplicate inputs, state/scope mismatches, partial payment rejection, payable/funding checks, exact totals and counters.
- Added optional PostgreSQL integration scenario with separate connection pool for competing batch payments, stored postings/links/statuses, unique constraints, deferred commit failure and retry.
- Direct review examined lock ordering, original amount preservation, referential constraints, payment links, shared counters, money precision, and error sanitization.

- Verification: 5 focused request tests passed; full npm test 182 passed, 5 skipped, 0 failed. JavaScript syntax and git diff --check passed.
- PostgreSQL integration scenarios are implemented but were not executed without TEST_DATABASE_URL. Migration 035 has not been applied and no live data was modified.
- Direct review found no unresolved implementation defect. Database links prevent duplicate payments even if an expense status is manually reset; full stored amounts and original payable postings remain authoritative.
