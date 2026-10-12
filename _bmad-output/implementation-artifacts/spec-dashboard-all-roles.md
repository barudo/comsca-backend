---
title: 'Allow all group roles to access the dashboard'
type: 'feature'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Make GET /api/v1/dashboard accessible to all user types.

</frozen-after-approval>

## Implementation Notes

- Add MEMBER to the existing OWNER/ADMIN/TREASURER/AUDITOR role allowlist. Retain verified authentication and selected-group membership requirements.
- Response data and cycle selection remain as implemented. No schema or external changes needed; small reversible authorization change with no unresolved intent gaps.
- Update existing role tests and README. No subagents per session preference.
- Verification: all three local dashboard tests passed, covering every group role, empty cycle, authentication and cross-group rejection. Local diff review and whitespace check passed. No deferred findings.
