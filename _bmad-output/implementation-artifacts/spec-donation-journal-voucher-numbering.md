---
title: 'Number donations with cycle journal vouchers'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Each successful donation increments the current cycle journal_voucher_counter once and stores the returned value as transactions.document_number with document_type JOURNAL_VOUCHER. Return both fields. Share the existing journal sequence and atomically roll back allocation with any failed accounting writes. Preserve exact bigint values. The user requested direct work without subagent testing.

</frozen-after-approval>

## Implementation Notes

- Donations opt into numbering through journalVoucher in the shared group-account handler. Expenses retain their existing allocation and response behavior.
- Allocation occurs after validation under the existing cycle lock and uses SQL increment/returning inside the accounting transaction.
- Added request regression tests for exact large counters, repeated allocation, write and commit rollback, exhaustion, rejected requests, and expense isolation.
- Direct review completed; no subagents used. Checked counter scope, lock placement, numeric precision, response projection, and shared-handler isolation.
- Verification: focused suite 25 passed; full npm test 171 passed, 4 skipped, 0 failed. git diff --check passed. PostgreSQL integration tests were skipped; no live database validation was performed.
