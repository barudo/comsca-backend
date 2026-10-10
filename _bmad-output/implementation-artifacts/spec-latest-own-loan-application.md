---
title: 'Get latest own loan application'
type: 'feature'
created: '2026-10-10'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add GET /api/v1/me/loans/apply returning the latest loan application for the
authenticated current user in the selected group.

</frozen-after-approval>

## Implementation Notes

- Small reversible change; no schema changes or external actions. Reuse authentication and group middleware.
- Resolve the caller's group user ID server-side. All group roles have access; absent group membership returns 403.
- Follow active-record visibility convention; return latest non-deleted application across cycles, created_at descending then id descending. Return 200 with success and loan_application (null when absent).
- Update handler, routes, README and existing local HTTP tests. Continue without subagents per session preference.
- All six loan-application HTTP tests passed using the mocked Knex runner; no live database test was run. Local review and git diff --check passed. No deferred findings.
