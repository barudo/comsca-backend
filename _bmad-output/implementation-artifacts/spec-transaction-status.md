---
title: 'Transaction status and active member history'
type: 'feature'
created: '2026-10-06'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>
## Intent
Add transactions.status with allowed values active and voided, defaulting to active. GET /api/v1/me/transactions must return only entries belonging to active transactions.
</frozen-after-approval>

## Implementation Notes
- Migration 032 adds a non-null status column with an active default and a database check constraint. Existing rows receive active. Rollback removes the constraint and column.
- The member history query filters the joined transaction header, preserving existing membership, cycle scope, ordering and response shape.
- All three member history tests pass, including an assertion on the active-only SQL predicate. Migration syntax and whitespace checks pass.
- Migration has not been applied or tested against a live database. Subagent testing and review omitted per session preference.
