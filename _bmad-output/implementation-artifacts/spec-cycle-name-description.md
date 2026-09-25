---
title: 'Add cycle name and description columns'
type: 'feature'
created: '2026-09-25'
status: 'in-review'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add a migration that adds name and description fields to cycles.

User follow-up: add a separate migration for the currency column `absence_penalty`, correcting its spelling within migration 015.

User follow-up: include the currency column `required_monthly_contribution` in the same migration 015.

</frozen-after-approval>

## Implementation Notes

- Small, reversible file addition; no database migration execution or external side effects.
- Follow migrations 001 and 007: nullable name varchar(255) and description text preserve existing rows and inserts. Add rollback dropping both columns.
- API changes are outside this migration request. Existing explicit column selections remain valid.
- Added migrations 014 and 015 with rollback functions. Penalty uses nullable decimal(18, 2), with a nonnegative, non-NaN check matching existing financial migration conventions.
- Verified PostgreSQL SQL generation for both directions of both migrations without database execution. Existing suite: 53 passed, 1 skipped; HTTP tests required local port binding outside the sandbox.
- Independent review was attempted but the reviewer failed due to the account usage limit. Review remains pending; implementation was checked locally against migrations 001 and 007.
- Added nullable required_monthly_contribution decimal(18, 2) to migration 015 with a nonnegative, non-NaN check and rollback of both currency columns and constraints.
