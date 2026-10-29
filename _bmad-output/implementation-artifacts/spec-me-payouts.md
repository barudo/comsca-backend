---
title: 'Read own current distribution'
type: 'feature'
created: '2026-10-29'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Add authenticated GET /api/v1/me/payouts returning the signed-in user's distribution in the selected group's current distributing cycle. Allow any authenticated group profile including MEMBER, consistent with other /me routes. Return success, cycle (id/status or null), distribution (one existing distribution row with safe user profile and decimal-string remaining_amount, or null). No cycle or user input selects another person's records. No distributing cycle returns 200 with null cycle/distribution; no distribution for this user returns null distribution. A distributing legacy cycle without a declaration returns 409 as existing distribution reads do. Preserve financial-role restrictions on group-wide endpoints.

</frozen-after-approval>

## Implementation Notes

Small additive read endpoint; no migration. Use read-only repeatable-read transaction and existing group-reader role/RLS after resolving the authenticated profile. Query distributions by group, cycle and actor ID, never retrieve all members. Profile fields: id, first_name, family_name, username. Existing bigint cents helpers compute remaining_amount. Verify with real PostgreSQL HTTP tests for MEMBER access, spoofed query parameters, missing profile, active/closed lifecycle and accurate partial payment amounts. No irreversible actions.


## Review Triage Log

- false: one auth identity with multiple group profiles is disallowed by the unique auth_user_id constraint in migration 004. Existing cross-group missing-profile and query-spoofing tests cover reachable isolation paths.
- medium, patched: added unpaid and fully paid progress checks with exact decimal string remaining amounts, alongside existing partial payout coverage.
- low, patched: added MEMBER HTTP checks for active and closed null responses.

Verification: seven targeted payout/distribution tests passed with zero skips on disposable PostgreSQL. Expanded own-distribution integration test passed again after review additions. No database migration, no configured database changes, no deferred findings. git diff --check passed.
