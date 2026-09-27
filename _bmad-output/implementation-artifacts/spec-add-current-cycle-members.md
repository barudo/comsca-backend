---
title: 'Add users to the current cycle'
type: 'feature'
created: '2026-09-27'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement POST /api/v1/cycles/members accepting {users:[user IDs]}. Require bearer authentication and x-group-slug. Only the selected group's OWNER/ADMIN can enroll users. Resolve the current draft/active/distributing cycle; do not accept caller cycle/group overrides. Validate a nonempty list of at most 1000 positive bigint IDs, accepting safe JSON integers or decimal strings. Deduplicate the list, verify every user belongs to the group, and insert cycle_members atomically, ignoring existing memberships. Lock authorization, cycle lifecycle and user scope while processing. Return 200 with success, current_cycle_id, normalized users and added_count. Missing current cycle is 409; unavailable users are a generic 404; malformed input is 400; unauthorized access is 403. Preserve other cycles and group isolation. No schema migration is required.

</frozen-after-approval>

## Implementation Notes

- Existing uncommitted cycle-counter changes belong to prior user requests and are preserved.
- Use the existing cycle_members composite primary key for idempotent insertion.

- Added handler/route, README contract, five endpoint request tests and a PostgreSQL integration scenario.
- Verification: 28 targeted request tests passed, syntax checks and git diff --check passed. PostgreSQL tests were not run: privileged test setup remains blocked by approval-service usage limits.
- No commit attempted while privileged operations are blocked; prior cycle-counter edits remain preserved.

## Review Triage Log

- No concrete defects found in independent review of authorization, group isolation, IDs, atomicity, locking or retry behavior.
- Low verification gap: simultaneous PostgreSQL enrollment, cycle closure and role revocation are not yet exercised; SQL locking clauses are covered by request tests and sequential database coverage is present but unexecuted. No functional defect demonstrated; live database verification remains pending.
