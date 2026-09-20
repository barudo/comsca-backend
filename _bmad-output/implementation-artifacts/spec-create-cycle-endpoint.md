---
title: 'Create group cycles as OWNER or ADMIN'
type: 'feature'
created: '2026-09-20'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add POST /cycles and the existing-convention /api/v1/cycles alias. Verify bearer
identity and require an OWNER or ADMIN database profile in the group resolved
from x-group-slug. Lock that profile during the transactional insert, matching
member creation. Accept only migration-backed editable cycle fields:
interest_rate, interest_period, interest_method, cost_per_share, and status. The interest
triple is either entirely null/omitted or entirely supplied; periods are DAILY,
WEEKLY, MONTHLY, YEARLY and methods SIMPLE, COMPOUND. Rate is nonnegative
numeric(9,6), cost is positive numeric(18,2), both optional. Accept ordinary
JSON numbers or fixed-point decimal strings, reject precision overflow instead
of silently rounding. Reject unknown fields, including group/ID/time overrides.
Return 201 with success and cycle; reject malformed input with 400 and callers
without a matching manager profile with 403. Do not expose database error details.
The user has resolved the prior migration decision: all existing cycles and new
cycles without a status are inactive. Complete migration 011 alongside this
endpoint, allowing active, inactive, distributing. Enforce at most one active
cycle per group using a partial unique index, and return 409 on that specific
constraint violation. No deployment or live database mutation.

</frozen-after-approval>

## Implementation Notes

- Inspected migrations 001 and 007 and existing member creation authorization.
- Only pre-existing worktree change is our prior draft status spec; preserved.
- Files: src/routes/cycles.js, src/app.js, test/cycles.test.js, README.md.
- Initial scope used the current schema; superseded by the user's status-backfill
  decision below, which authorizes migration 011 alongside this endpoint.

- User resolved historical-data choice during implementation; the frozen intent
  now records the explicitly authorized migration and endpoint status support.
- Added migration 011 with transactional backfill, status check and unique index.
- Implementation scope expanded by the user's answer to include migration tests.

- Request tests cover both aliases, all allowed values, defaults, nulls, precision
  limits, unauthorized access, protected-field rejection, and sanitized errors.
- Disposable PostgreSQL 18 tests cover backfill, rollback/reapply, preserved
  financial settings/memberships, concurrent activation conflicts, and concurrent
  role revocation. Runtime databases were not modified.
- Full integration run revealed an older accounting test that assumed the prior
  PostgreSQL RESTRICT SQLSTATE; now accepts 23503 or 23001 only for the exact
  expected transaction_entries_group_account_fk constraint.

## Review Triage Log

- medium / patched: Numbers above MAX_SAFE_INTEGER could already be rounded by
  JSON parsing. Reject unsafe numeric magnitudes, require decimal strings there,
  and exercise a raw JSON request containing 9007199254740993.
- medium / patched: Competing activation could be sequential. The database test
  now observes pg_blocking_pids before committing the first writer.
- low / patched: Migration preservation checks lacked populated data. Seed and
  compare actual financial settings and a cycle membership through rollback.
- low / patched: Request fixtures did not return timestamps. They now return and
  assert them; the database test compares response timestamps to saved values.
- medium / patched: Static authorization alone did not prove revocation handling.
  A second connection holds a role downgrade; creation waits then returns 403
  without inserting when that downgrade commits.
- low / patched: Planning notes described the earlier schema-only scope. Record
  the explicit scope change and reconcile the status spec with endpoint delivery.

- medium / documented: JSON numeric tokens may round before handler validation
  even below MAX_SAFE_INTEGER. The public contract now explicitly distinguishes
  post-parse numeric validation from exact decimal-string validation; financial
  examples use strings. No raw-body parser or new numeric format was introduced.

## Verification

- All 47 tests passed with TEST_DATABASE_URL pointing to a disposable PostgreSQL
  18 container; no skips. The container is removed after verification.
- Independent review found no remaining migration or authorization blocker.
- git diff --check passed.
