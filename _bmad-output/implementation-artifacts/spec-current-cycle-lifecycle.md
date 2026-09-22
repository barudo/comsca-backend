---
title: 'Protect historical cycles and enforce one current lifecycle'
type: 'feature'
created: '2026-09-22'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement the approved lifecycle draft -> active -> distributing -> closed.
The current cycle is the only non-closed cycle in a group. Financial edits are
allowed only on that draft. All API updates to a closed cycle, including reopening
and status-only no-ops, return 409. Non-closed status-only retries are no-ops.
Create only drafts, defaulting omitted status to draft; reject other creation
statuses. A partial unique database index prevents multiple non-closed cycles
under concurrent writes. Creating a new draft requires the previous cycle to
be closed. PATCH preserves OWNER/ADMIN authorization, group isolation, actor/cycle
locking, partial-field validation, and atomic transitions.
GET /groups/users must identify current membership from the non-closed cycle,
never from the most recent historical row. With no current cycle return null
current_cycle_id and false membership flags. Extend the group reader's RLS
column grant to include status.
Add migration 012 without editing historical migrations. Preserve cycle IDs,
financial settings, memberships and timestamps. Preserve active/distributing
rows; abort atomically if any group already has multiple such cycles rather
than guessing which live/unpaid cycle is historical. Document a preflight
query, existing-row conversion, versioned deployment, breaking API changes,
rollback limitations, and the close/new-draft flow. Do not apply to live databases.

</frozen-after-approval>

## Implementation Notes

- User explicitly approved the four-state/current-cycle proposal and requested
  implementation and documentation.
- Asked for an optional legacy classification preference, then proceeded after
  allowing time for a reply with the stated conservative default: all legacy
  inactive rows become closed. Existing active/distributing rows retain status.
  This preserves historical immutability; no live migration is run.
- Current code has no other cycle mutation routes; lifecycle is enforced by the
  API, while non-closed uniqueness is enforced by PostgreSQL for all writers.
- Scope: migrations/012_current_cycle_lifecycle.js, src/routes/cycles.js,
  src/routes/group-user-list.js, tests, README.md and docs/project-context.md.

- Migration 012 takes a cycles-table writer lock, preflights conflicting ongoing
  groups, converts legacy inactive rows to closed, changes the default to draft,
  enforces the four allowed statuses and one non-closed cycle, and extends the
  group reader's status-column grant. Down migration restores 011's schema;
  classification loss and maintenance requirements are documented.
- POST only creates drafts, PATCH freezes closed history, and group user listing
  resolves membership using the non-closed cycle. Existing token/role/group and
  financial validation remains in place.
- Added docs/cycle-lifecycle.md and updated README and repository context.

## Review Triage Log

- low / patched: Mock transition tests verified no-write retries, but PostgreSQL
  tests did not prove saved timestamps stay unchanged for draft/active/distributing
  status-only retries. Added full-row comparisons for all three statuses.
- Full follow-up review included migration, grants, rollback, docs and routes;
  no further concrete defects found. No deferred work.

## Verification

- npm test with a disposable PostgreSQL 18 TEST_DATABASE_URL: 56 passed, zero
  failures, zero skips. The logged migration rejection is an expected assertion
  for ambiguous ongoing legacy data; all changes roll back in that test.
- Tests cover legacy conversion/data preservation, migration up/down/reapply,
  unique current-cycle inserts and updates, default/invalid statuses, RLS grants,
  read-only history after a new draft, concurrent create and close/edit races,
  committed role revocation, no-current membership and newer historical rows.
- git diff --check passed. Disposable container removed after verification.
- No production migration, deployment or remote push was performed.
