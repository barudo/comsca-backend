---
title: 'Number expenses with cycle journal vouchers'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/transactions/add-expense allocates one number from the current cycle journal_voucher_counter and stores and returns document_number with document_type JOURNAL_VOUCHER. Share the sequence with donations and other journal vouchers, preserve bigint precision, and roll back allocation with failed accounting writes.

</frozen-after-approval>

## Implementation Notes

- Enabled the shared handler's existing journalVoucher rule for expenses. No migration or live data changes.
- Reused numbering regression tests for both donations and expenses, including bigint precision, exhaustion, insert failures, and commit failures.
- Added alternating expense/donation allocation coverage and rejection checks for client-supplied document fields, invalid input, unauthorized roles, and missing writable cycles.
- Direct review checked the shared handler's cycle lock, increment/returning, transaction boundaries, response fields, and scope. No subagents used, following the user's preference.
- Verification: focused tests 27 passed; full npm test 173 passed, 4 skipped, 0 failed; git diff --check passed. PostgreSQL integration tests remain skipped; no live database validation performed.
