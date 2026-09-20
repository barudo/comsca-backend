---
title: 'Cycle status and one active cycle per group'
type: 'feature'
created: '2026-09-20'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Cycles have no lifecycle status, and PostgreSQL currently permits
multiple active cycles within a group because that concept is not represented.

**Decision:** The user selected inactive for all existing cycles and as the default
for new cycles. Completed with the POST /cycles endpoint under spec-create-cycle-endpoint.md.

**Approach:** Add a migration introducing a required `cycles.status` field with
exactly three lowercase values: `active`, `inactive`, and `distributing`.
`distributing` means the cycle has ended and proceeds are being distributed to
members. Enforce at most one active cycle per group at the database level.

## Boundaries & Constraints

**Always:** Use a new Knex migration with up/down support. Preserve cycles,
memberships, financial settings, and existing group isolation. Enforce uniqueness
on both inserts and updates, including concurrent writes. Groups may have zero
active cycles, and distinct groups may each have their own active cycle.

**Never:** Apply migrations to a configured production database during this work.
The user subsequently requested POST /cycles; implement creation alongside this migration. Do not introduce payout processing. Do not change the
existing latest-cycle semantics of the group user listing in this migration task.
Do not infer which historical cycles are distributing proceeds from timestamps.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First activation | Group has no active cycle | Cycle can become active | None |
| Duplicate activation | Same group already has an active cycle | Insert or update rejected | PostgreSQL unique violation |
| Independent groups | Another group has an active cycle | Activation succeeds | None |
| End active cycle | Active becomes distributing or inactive | Another cycle can activate | None |
| Historical cycles | Multiple inactive/distributing cycles | Allowed | None |
| Invalid status | Unknown string, uppercase variant, or null | Rejected | Check or not-null violation |
| Rollback | Status migration applied | Remove status and its constraints; keep cycle rows | Transactional rollback on error |

</frozen-after-approval>

## Code Map

- `migrations/001_create_groups_users_cycles.js`: creates cycles with group_id,
  created_at, and updated_at; all historical cycles lack a lifecycle field.
- `migrations/007_add_cycle_financial_settings.js`: existing named check-constraint
  and reversible migration conventions.
- `migrations/010_scope_group_user_list.js`: most recent migration, grants a
  restricted role SELECT on specific cycle columns; status is not currently read.
- `src/routes/group-user-list.js`: latest-cycle lookup by created_at/id; preserve
  that endpoint behavior for this schema-only request.
- `test/login.integration.test.js`: disposable PostgreSQL integration suite;
  currently rolls back three latest migrations to exercise role rollback. Must
  account for the additional migration before these existing assertions.
- `README.md`: database migration documentation and integration-test prerequisites.

## Tasks & Acceptance

**Execution:**
- [x] `migrations/011_add_cycle_status.js` -- add a non-null status column, named
  allowed-values check, and partial unique index on group_id WHERE status =
  'active'; apply the user's selected backfill/default; provide a down migration.
- [x] `test/login.integration.test.js` -- adjust rollback sequencing and add
  database-level checks for accepted statuses, invalid/null values, duplicate
  active inserts/updates, different groups, release after deactivation, existing
  rows, and down/up preservation. Use explicit statuses where appropriate.
- [x] `README.md` -- document lifecycle values, selected default/backfill, and
  how the database enforces at most one active cycle per group.

**Acceptance Criteria:**
- Given existing cycles, when migration 011 runs, then every row receives the
  user-selected status without losing rows or changing memberships.
- Given a group with an active cycle, when another transaction activates a second
  cycle, then PostgreSQL prevents both from committing as active.
- Given the migration has been applied, when it is rolled back and reapplied,
  then the schema is valid and existing cycle identities remain intact.
- Given the current HTTP routes, when the migration is introduced, then existing
  request tests continue to pass and no endpoint contract changes.

## Implementation Notes

- Migration 011 is implemented with inactive backfill/default, allowed-status
  check, and a partial unique index for active cycles.
- Verified against disposable PostgreSQL 18: up/down/up preserves cycle data and
  memberships; concurrent activations cannot both succeed. All 47 tests pass.
- Delivered with POST /cycles; see spec-create-cycle-endpoint.md for review triage.

## Spec Change Log

## Review Triage Log

## Design Notes

Use a PostgreSQL partial unique index rather than an application check: competing
writers must not both pass a preflight query. The uniqueness predicate covers
only active cycles, as requested. It does not prevent multiple distributing
cycles or an active cycle alongside a distributing cycle. A varchar column and
named check match existing migration conventions and avoid a standalone enum
that needs separate cleanup during rollback.

The migration and POST /cycles endpoint are authored together after the user
extended the request; applying migrations remains a later deployment operation. Rolling down necessarily discards status labels, which must be
called out in the migration documentation.

## Verification

**Commands:**
- `npm test` -- all request tests pass; explicitly report integration skips.
- `TEST_DATABASE_URL=<disposable-db> node --test test/login.integration.test.js`
  -- when a dedicated empty PostgreSQL database is available, exercise actual
  constraints, backfill, and migration rollback/reapply.
- `git diff --check` -- no whitespace errors.
