---
title: 'Include user profiles in distribution members'
type: 'feature'
created: '2026-10-28'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Include a nested `user` object in each `summary.members` entry returned by cycle distribution retrieval, and in each raw `distributions` entry for consistent frontend consumption. Preserve `user_id` and all accounting fields. Expose only id, first_name, family_name and username; never password or auth identity. Scope profile lookup to the selected group and return current profile information without modifying stored declarations. The shared retrieval service also serves cycle status update responses.

</frozen-after-approval>

## Implementation Notes

Small additive response change; no migration or irreversible actions. Existing group-reader grants permit these profile columns. Batch lookup avoids one query per member. Verify existing real PostgreSQL distribution integration tests, including restricted role reads, with assertions for exact safe profile keys and unchanged cross-group restrictions.


## Review Triage Log

- medium / patched: current-profile behavior lacked coverage. Added rename/retrieve checks for both collections and verified declaration and distribution database rows remain unchanged.
- false: nullable-user documentation mismatch is not reachable with existing composite foreign keys and group-reader RLS. Each distribution references a user in the selected group; the same group condition applies to profile lookup. The null fallback does not alter valid API results; no new missing-user contract is introduced.

Verification: all seven targeted payout/distribution tests passed on disposable PostgreSQL with no skips; current-profile regression also passed. No migration needed. No findings deferred.
