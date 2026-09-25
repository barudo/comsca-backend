---
title: 'Return the latest qualifying cycle'
type: 'feature'
created: '2026-09-25'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

GET /api/v1/cycles returns the latest cycle whose status is draft, distributing, or active.

</frozen-after-approval>

## Implementation Notes

- Preserve the existing success/current_cycle_id/cycles response envelope, with at most one cycle; no match yields an empty array and null ID.
- Filter by group and explicit allowed statuses before ordering by created_at DESC, id DESC and limiting to one in SQL.
- Preserve authorization and transaction-local RLS. No database changes or execution.
- Existing GET alias shares the handler; no new unversioned endpoint introduced.
- Updated README and query assertions plus coverage for all allowed statuses, closed-only/empty groups, newer closed records, timestamp ties, authorization, and errors.
- Focused verification: all 18 cycle tests pass; git diff --check passes.
- Independent review found no concrete defects. Tests inspect generated SQL and emulate database results; no live PostgreSQL validation performed.
