---
title: 'Number interest charges with cycle journal vouchers'
type: 'feature'
created: '2026-10-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/interests/charge increments the current cycle's journal_voucher_counter once per successful charge and stores the resulting number in transactions.document_number. The user confirmed journal_voucher_counter is the intended cycle field; no journal_voucher_number column is needed. Use JOURNAL_VOUCHER as document_type, return both document fields, and commit the counter and accounting records atomically. Invalid or zero-charge requests consume no number. Preserve bigint precision and existing interest calculations.

</frozen-after-approval>

## Implementation Notes

- Small local change with no schema migration or live data changes.
- Reuse the cycle lock and atomic increment/returning pattern from loan-disbursements.js in interests.js, after positive-interest validation and before header insertion.
- Extend request tests and optional PostgreSQL integration assertions for allocation, persistence, and rollback; document the response behavior.

- Implemented atomic SQL increment with RETURNING after charge validation; exposed JOURNAL_VOUCHER document fields in the response.
- Verification: focused tests 8/8 passed; full npm test 163 passed, 4 skipped, 0 failed; git diff --check passed. PostgreSQL integration coverage added but not executed because no disposable test database is configured.

## Review Triage Log

- low, patched: sequential integration requests did not verify allocation contention. Added simultaneous requests and consecutive-number/final-counter assertions.
- low, patched: bigint precision only had mock coverage. Added PostgreSQL assertions above Number.MAX_SAFE_INTEGER for response, stored numbers, and cycle counter.
- low, patched: counter-update overflow lacked coverage. Added unit and PostgreSQL cases for bigint maximum, 409 response, preserved counter, and no accounting writes.
