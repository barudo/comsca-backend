---
title: 'Cycle document counters'
type: 'feature'
created: '2026-09-27'
status: 'in-progress'
route: 'oneshot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add a new cycles migration with independent `receipt_counter`, `disbursement_voucher_counter`, and `journal_voucher_counter` columns. Use nonnegative bigint values, not nullable, defaulting to zero for both existing and new cycles. Zero means no document number has been allocated. Supply rollback that removes the columns and checks. Do not modify existing migrations or public cycle response fields. Number allocation, document fields on transactions, group-level counters and applying migrations to the application database are outside this request.

</frozen-after-approval>

## Implementation Notes

- Migration 022 adds the three counters and check constraints. Existing financial history does not contain document numbers to backfill.
