---
title: 'Update loan applications on disbursement'
type: 'feature'
created: '2026-10-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

On POST /api/v1/transactions/disburse-loans, update all loan applications belonging to the selected user in the authenticated group to inactive and set each amount_disbursed to the disbursed amount. Apply this across cycles and existing statuses, as requested. Commit the application changes atomically with the accounting records; allow disbursement when no applications exist.

</frozen-after-approval>

## Implementation Notes

- Small local code change with no migration, deployment, or live data mutation.
- Update src/handlers/loan-disbursements.js using the existing transaction and normalized decimal string; refresh updated_at.
- Extend test/loan-disbursements.test.js to verify all matching applications, isolation, exact amounts, no matching applications, and rollback on failures. Document behavior in README.md.

- Implemented the scoped bulk update and README behavior description.
- Verification: npm test completed with 160 passed, 4 skipped, 0 failed. Tests use mocked database execution, not a live PostgreSQL instance.

## Review Triage Log

- low, patched: shared database/transaction mock could hide an update using the wrong connection. Added a distinct transaction wrapper and require application updates to use its builders.
- low, patched: rejection tests only tracked accounting inserts. Added assertions that invalid and unauthorized requests never attempt an application update.
- low, patched: mock affected-row count included unrelated applications. Count matches only and cover disbursement with exclusively unrelated applications.
