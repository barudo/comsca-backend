---
title: 'Deactivate prior managed loan applications'
type: 'feature'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/loans/apply deactivates existing applications for the given user
before inserting a new active loan application with amount_desired.

</frozen-after-approval>

## Implementation Notes

- Scope previous active rows to the selected group and user across cycles; preserve deleted records. Update updated_at on deactivation.
- Validate first, then update and insert within existing transaction and current-cycle lock. Managed endpoint only; self and legacy routes retain behavior.
- Add migration 033 to allow inactive status. Rollback refuses to remove support while inactive records exist, preserving history. Migration authored only, not applied.
- Local tests cover update scope, explicit active insert, validation and simulated transaction rollback. No subagents per session preference.
- Nine local HTTP tests passed with mocked Knex execution; git diff --check passed. No live database verification performed. Local review found no additional defects.
