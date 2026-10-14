---
title: 'Number penalty charges with cycle journal vouchers'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/penalties/charge increments the cycle journal_voucher_counter once per successful request, sharing the sequence used by interest and contribution charges. Save and return transactions.document_number with document_type JOURNAL_VOUCHER. Preserve bigint precision and commit the counter with all accounting records. Invalid requests and failed charges consume no number. Preserve existing roster, cycle, and calculation rules.

</frozen-after-approval>

## Implementation Notes

- Small local change with no migration or live data mutation. Reuse the existing cycle lock and atomic increment after validation in penalties.js.
- Extend request tests, optional PostgreSQL integration coverage, and README documentation. Verify batching, precision, overflow, rollback, and shared allocation.
