---
title: 'Scope transaction registers to current cycle'
type: 'feature'
created: '2026-11-08'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Return only transactions in the selected group's current active or distributing cycle from GET /api/v1/transactions/registers. When no such cycle exists, including when the latest cycle is closed, return an empty data array.

</frozen-after-approval>

## Implementation Notes

- Follow the active/distributing cycle selection used by the accounting reports. Preserve the existing paginated response, validation, authorization, ordering and repeatable-read snapshot.
- Scoped both count and page queries by group and selected cycle. Empty results retain pagination metadata and validation.
- Updated README and request tests for active, distributing, closed, draft, absent, and other-group cycles. Tests mock database execution and assert the generated SQL and bindings.
- Verification: 8 focused tests passed; git diff --check passed. Independent review reported no significant issues. No live database or deployment was used.
