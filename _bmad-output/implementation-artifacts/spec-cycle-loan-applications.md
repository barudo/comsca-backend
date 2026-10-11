---
title: 'List current-cycle members and loan applications'
type: 'feature'
created: '2026-10-11'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add GET /api/v1/loans/apply returning all members of the current cycle and their
loan applications in the selected group.

</frozen-after-approval>

## Implementation Notes

- Small reversible endpoint addition; no migration or external side effects.
- Reuse roster financial read roles (OWNER/ADMIN/TREASURER/AUDITOR), application cycle selection (draft/active/distributing), and latest active application semantics.
- Return success, current_cycle_id and members, each with public identity fields and nullable loan_application. Select latest application within this cycle by created_at and ID; include members without applications. No cycle returns null ID and empty members.
- Read authorization, cycle, roster and applications in one repeatable-read read-only transaction. Explicit group filters prevent cross-group reads. PostgreSQL DISTINCT ON avoids per-member queries and preserves driver decimal/ID strings.
- Update handler, route, README and local HTTP tests. No subagents per session preference.
- Verification: all eight local loan-application HTTP tests passed with mocked Knex query execution, including query scope/order, financial roles, absent applications and empty cycles. No live database test run. Local diff review and whitespace check passed; no deferred findings.
