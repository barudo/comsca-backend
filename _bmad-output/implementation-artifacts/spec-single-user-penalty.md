---
title: 'Charge a penalty to one selected user'
type: 'bugfix'
created: '2026-10-21'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Accept required user_id on POST /api/v1/penalties/charge. Create one transaction and one transaction entry for that enrolled user, with the requested amount and exactly two account entries. Preserve authorization, scoped accounts, atomic writes and voucher numbering.

</frozen-after-approval>

## Implementation Notes

- Completed the existing user_id edit in src/handlers/penalties.js; removed the premature return and roster multiplication. Membership lookup is scoped to user, cycle and group.
- Updated test/penalties.test.js and README.md for single-user charges, validation, exact amounts and rollback behavior.

- Updated database-backed penalty callers and persistence assertions; added rejection checks for unenrolled and other-group users.
- Validation: 188 tests passed, 5 database integration suites skipped without TEST_DATABASE_URL. All 8 penalty tests passed.

## Review Triage Log

- medium, patched: integration callers omitted user_id and asserted roster totals; updated to selected-user contract.
- low, patched: membership boundary coverage was incomplete; added database-backed checks for unenrolled and other-group users with unchanged accounting counts and voucher counter.
