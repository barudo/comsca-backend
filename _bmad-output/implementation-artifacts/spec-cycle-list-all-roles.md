---
title: 'Allow all group roles to list cycles'
type: 'feature'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/cycles available to all user types.

</frozen-after-approval>

## Implementation Notes

- Add TREASURER, AUDITOR and MEMBER to cycle listing permissions. Keep verified authentication, group membership and the scoped database reader.
- Small reversible authorization change with no unresolved intent gaps or schema changes. Existing cycle selection and write permissions remain in place.
- Update role matrix tests and README. No subagents per session preference.
- Verification: 23 local cycle listing and write tests passed, including access for all roles and rejection of unauthorized writes and cross-group reads. Local diff review and whitespace check passed; no deferred findings.
