---
title: 'Allow all group users to view the balance sheet'
type: 'feature'
created: '2026-10-13'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/accounting/balance-sheet accessible to all user types.
No subagent testing required.

</frozen-after-approval>

## Implementation Notes

- Remove the role restriction, following trial-balance access. Authentication and a user profile in the selected group remain required for tenant isolation.
- Small reversible authorization change with no schema changes or unresolved intent gaps. Existing response and cycle selection retained.
- Update local role tests and README; no subagents.
- All three local balance-sheet tests passed, including all five roles, unauthenticated requests, cross-group rejection before cycle reads, balance calculations and empty-cycle response. Local diff review and whitespace check passed; no deferred findings.
