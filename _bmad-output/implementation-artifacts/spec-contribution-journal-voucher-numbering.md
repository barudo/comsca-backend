---
title: 'Number contribution charges with cycle journal vouchers'
type: 'feature'
created: '2026-10-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/contributions/charge increments the cycle journal_voucher_counter once per successful request, sharing the sequence used by interest charges. Save and return the resulting transactions.document_number with document_type JOURNAL_VOUCHER. Preserve bigint precision and commit the counter with all accounting records. Invalid requests and failed charges consume no number. Existing roster, cycle, and calculation rules stay in effect.

</frozen-after-approval>

## Implementation Notes

- Small local change; no schema migration or live data changes. Reuse the existing cycle lock and the interest charge atomic increment pattern after validation.
- Update contributions.js, request tests, optional PostgreSQL integration tests, and README.md. Verify multiple members and batches, precise large counters, failures and overflow.

- Implemented atomic increment with RETURNING, transaction document fields, and 22003 conflict handling for exhausted bigint counters.
- Verification: focused tests 9 passed; full npm test 165 passed, 4 skipped; git diff --check passed. PostgreSQL integration tests were not executed because no disposable test database is configured.

## Review Triage Log

- low, patched: shared sequence lacked endpoint-spanning coverage. Added alternating contribution and interest requests in one cycle.
- low, patched: contribution allocation contention lacked coverage. Added concurrent contribution/contribution/interest requests with distinct consecutive persisted numbers.
- low, patched: precise bigint allocation and exhaustion only had mock coverage. Extended PostgreSQL assertions above Number.MAX_SAFE_INTEGER and at bigint maximum.
- low, patched: rejected requests lacked PostgreSQL counter assertions. Added validation and authorization rejection assertions preserving the counter.
