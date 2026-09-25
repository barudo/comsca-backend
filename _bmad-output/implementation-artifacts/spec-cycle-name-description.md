---
title: 'Add cycle name and description columns'
type: 'feature'
created: '2026-09-25'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add a migration that adds name and description fields to cycles.

</frozen-after-approval>

## Implementation Notes

- Small, reversible file addition; no database migration execution or external side effects.
- Follow migrations 001 and 007: nullable name varchar(255) and description text preserve existing rows and inserts. Add rollback dropping both columns.
- API changes are outside this migration request. Existing explicit column selections remain valid.
