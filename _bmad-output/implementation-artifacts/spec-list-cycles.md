---
title: 'List group cycles through the missing GET endpoint'
type: 'feature'
created: '2026-09-22'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement GET /cycles and /api/v1/cycles so the reported Cannot GET error is
resolved in the backend. Match existing cycle-management permissions: require a
verified Bearer token and an OWNER/ADMIN database profile in the group selected
by x-group-slug. Return 200 {success: true, current_cycle_id, cycles}, containing
current and closed cycles, ordered by created_at descending then id descending.
Return the explicit cycle fields already used by POST/PATCH; preserve decimal
strings. Derive current_cycle_id from the sole non-closed row, or null; empty
groups return an empty cycles array. Query parameters cannot override group or
current-cycle selection. Use the existing restricted comsca_group_reader role
inside a transaction with local app.group_id so RLS protects the list query.
Add a reversible grant-only migration 013 for the remaining cycle projection
columns; preserve existing grants and policies. Follow existing error conventions
and no-store responses. Document request/response and migration-before-deployment.
No live deployment or database changes.

</frozen-after-approval>

## Implementation Notes

- Clean working tree. Reuse cycleColumns, group middleware, authenticate, and
  migration 010's group_reader_select policy; migration 012 already grants status.
- Migration 013 grants interest_rate, interest_period, interest_method,
  cost_per_share, updated_at only, revoking just these on rollback.
- Tests: both aliases, roles/group boundaries, empty/history/current responses,
  precision/order, RLS, permission rollback/reapply, and pool context cleanup.
