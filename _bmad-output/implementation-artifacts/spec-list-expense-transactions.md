---
title: 'List expense transactions'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add GET /api/v1/transactions/expenses returning all EXPENSE transaction rows in the authenticated selected group, ordered by occurred_at descending. Return transaction fields including payment status and voucher fields. No cycle or payment-status filter was requested.

</frozen-after-approval>

## Implementation Notes

- Added ExpensesHandler.list and an authenticated route, reusing group middleware.
- Followed existing accounting read access: any authenticated group member. Use a repeatable-read, read-only transaction for membership and expense lookup.
- Response uses success/data, matching transaction-list conventions. Added id descending as a deterministic tie-breaker.
- Request tests verify generated SQL filters/order, response fields, all roles, group isolation, empty results, and sanitized errors.
- Direct review only, honoring the user's no-subagent preference.

- Verification: 4 focused tests passed; full npm test 177 passed, 5 skipped, 0 failed; git diff --check passed. Database calls in new request tests are mocked; no live PostgreSQL test was run.
