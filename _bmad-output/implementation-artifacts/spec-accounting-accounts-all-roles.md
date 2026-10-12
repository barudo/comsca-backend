---
title: 'Allow all group roles to view accounting accounts'
type: 'feature'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/accounting/accounts available to all user types.

</frozen-after-approval>

## Implementation Notes

- Add MEMBER to existing OWNER/ADMIN/TREASURER/AUDITOR access. Retain authentication, selected-group membership and scoped current-cycle queries.
- Small reversible authorization change; no schema changes, external actions or unresolved intent gaps.
- Update role coverage and documentation. No subagents per session preference.
- Both local accounting-account tests passed, covering identical balances for all five roles, unauthenticated and cross-group rejection, invalid roles and no current cycle. Local diff review and whitespace check passed; no deferred findings.
