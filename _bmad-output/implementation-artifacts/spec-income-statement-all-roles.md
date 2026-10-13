---
title: 'Allow all group users to view the income statement'
type: 'feature'
created: '2026-10-13'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/accounting/income-statement accessible to all user types,
following the balance-sheet access change. No subagent testing required.

</frozen-after-approval>

## Implementation Notes

- Remove the role restriction; retain authentication and a user profile in the selected group for tenant isolation.
- Small reversible authorization change with no schema changes or unresolved intent gaps. Existing response, date filters and cycle selection retained.
- Update local role tests and README; no subagents.
- All five local income-statement tests passed, covering all five roles, authentication, cross-group rejection before cycle reads, totals, date filtering and empty-cycle response. Local diff review and whitespace check passed; no deferred findings.
