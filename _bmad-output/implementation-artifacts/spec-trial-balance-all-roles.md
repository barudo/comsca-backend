---
title: 'Allow authenticated group users to view trial balance'
type: 'feature'
created: '2026-10-13'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/accounting/trial-balance accessible to all authenticated user types.
No subagent testing required.

</frozen-after-approval>

## Implementation Notes

- Remove role-based restriction, retaining authentication and a user profile in the selected group to preserve tenant isolation.
- Small reversible handler, test and documentation change; no schema changes or external effects. Response and cycle scope follow existing behavior.
- Local verification only; no subagents per user instruction.
- Both local trial-balance tests passed, covering all five roles, unauthenticated requests, cross-group rejection before cycle reads, balances and empty-cycle response. Local diff review and whitespace check passed; no deferred findings.
