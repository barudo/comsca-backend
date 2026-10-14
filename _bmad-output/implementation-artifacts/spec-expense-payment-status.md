---
title: 'Add nullable expense payment status'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add a migration for transactions.expense_payment_status with UNPAID and PAID values. The user chose to preserve NULL for existing expenses until reconciled. New expenses receive UNPAID when status is omitted; non-expense transactions remain NULL. Scope is migration creation, not application of migrations, payment endpoint implementation, or payment linkage.

</frozen-after-approval>

## Implementation Notes

- Migration 034 adds a nullable column and a check limiting non-null statuses to EXPENSE rows and UNPAID/PAID.
- An insert-only trigger supplies the conditional default. Unrelated updates preserve unknown legacy status. Explicit PAID is supported for reconciled/imported records.
- No existing rows are updated, avoiding deferred ledger trigger side effects.
- Down removes trigger, function, check, and column; documented loss of status values on rollback.
- Added optional isolated PostgreSQL integration coverage for legacy preservation, defaults, valid updates, invalid statuses, type constraints, down and reapplication.
- Direct review only, per user's no-subagent preference.

- Verification: migration JavaScript syntax and git diff --check passed. Full suite: 173 passed, 5 skipped, 0 failed. PostgreSQL migration test was skipped without TEST_DATABASE_URL; migration has not been applied.
