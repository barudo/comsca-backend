---
title: 'Paginated transaction document registers'
type: 'feature'
created: '2026-10-15'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add GET /api/v1/transactions/registers for OWNER and ADMIN users only, scoped to the selected group. Filter documents by PR, DV, JV, or all types when omitted/empty. Support per_page, page, sorty_by and asc/desc order and return matching transaction rows.

</frozen-after-approval>

## Implementation Notes

- PR includes RECEIPT and PAYMENT_RECEIPT because both types exist in the schema. All documents includes those plus DISBURSEMENT_VOUCHER and JOURNAL_VOUCHER, requiring a non-null number.
- No cycle/status filter requested; include all cycles and active/voided records.
- Defaults: 25 rows, page 1, occurred_at descending. Cap per_page at 100; reject unsafe offsets, repeated query keys, invalid filters/directions and sort columns.
- Support sort_by as an alias; conflicting aliases are invalid. Whitelist sort columns and use a same-direction ID tie-breaker with nulls last.
- Count and list queries share a repeatable-read, read-only snapshot. Response is success/data/pagination with numeric counts; money and bigint document fields retain database types.
- Direct review only; no subagents. Request tests cover filters, SQL scope/order, pagination metadata, roles, membership, bad inputs, and sanitized errors.

- Verification: 6 focused tests passed; full npm test 188 passed, 5 skipped, 0 failed; git diff --check passed. New request tests use mocked database execution; PostgreSQL integration tests were not run. No migration or live data changes.
