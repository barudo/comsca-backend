---
title: 'Update inactive cycles and advance cycle status'
type: 'feature'
created: '2026-09-21'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add PATCH /cycles/:id and /api/v1/cycles/:id for group OWNER/ADMIN users with
verified bearer identities. Resolve the group from x-group-slug, lock the actor
profile to serialize role revocation, and lock the matching group-owned cycle
before checking its saved status. Return 404 for absent/other-group cycles.
Allow financial-field changes only when the saved status is inactive. Accept
only the existing migration-backed fields and validate merged partial updates
using the creation validator, preserving omitted values and the interest triple
constraint. Reject empty requests and invalid bigint IDs with 400.
Allow only inactive -> active and active -> distributing status changes;
distributing has no outgoing transition. Lowercase wire values match the existing
schema. Repeating the current status without financial fields succeeds without
writing. Reject supplied financial fields on active/distributing cycles even
if unchanged. Inactive financial edits may accompany activation atomically.
Invalid transitions or frozen financial edits return 409, as does attempting
to activate a second cycle in a group. A failed patch must not change any fields.
Success returns 200 with success and the saved cycle including timestamps;
actual updates refresh updated_at, not created_at. Existing POST behavior and
schema remain unchanged. No migration or deployment is required.

</frozen-after-approval>

## Implementation Notes

- Clean worktree at start; existing status and create specs are completed.
- Reuse src/routes/cycles.js validator and role checks, migration 011 active-cycle
  index, and existing test setup. CORS already permits PATCH.
- Files: src/routes/cycles.js, test/cycles.test.js, test/login.integration.test.js,
  README.md, and this implementation record.
- All changes are local and reversible; no unresolved product decisions.

- Implemented group-scoped PATCH aliases with actor and cycle row locks. Reused
  financial validation on merged values, updating only supplied columns.
- Request tests cover the full transition matrix, immutable financial fields,
  role/group authorization, missing/invalid tokens, IDs, null handling, partial
  financial triples, protected fields, no-op retries, and active-slot conflicts.
- Database tests verify persistence, timestamp behavior, rollback of mixed edits,
  role revocation, concurrent activation versus editing, and competing PATCH
  activations from separate authorized profiles/connections.

## Review Triage Log

- medium / patched: CURRENT_TIMESTAMP uses transaction-start time and can be stale
  after a lock wait. Use clock_timestamp() and verify a successful waiting patch
  timestamps its update after the blocking writer releases the cycle.
- low / patched: Invalid financial input on a frozen cycle returned 400 before
  the documented 409. After shape/allowlist checks, reject any supplied financial
  field on a non-inactive cycle before validating its value. Added null/invalid
  value coverage.
- medium / patched: Same-row activation race did not exercise competing PATCH
  requests for the active slot. Added two identities and connections, synchronized
  at cycle locks, checking one 200/one 409 and rollback of losing financial edits.
- low / patched: Missing-token coverage did not prove verifier rejection on PATCH.
  Added a valid-header request whose identity verifier rejects it and asserted no
  cycle reads or writes.
- low / patched: Endpoint docs omitted missing/unknown group header responses.
  Added 400/404 documentation.
- Follow-up independent review confirmed all five findings addressed with no
  remaining concrete correctness blocker. No deferred findings.

## Verification

- Full npm test run against disposable PostgreSQL 18: 55 passed, zero failures,
  zero skips. Includes all existing tests and new lifecycle/concurrency checks.
- git diff --check passed.
- No live database or deployment was modified; disposable container removed.
