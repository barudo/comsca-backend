---
title: 'Update own profile and password'
type: 'feature'
created: '2026-09-26'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Provide PUT /api/v1/users/me to update the authenticated user's first_name, family_name, and address only. Provide PUT /api/v1/users/me/password accepting new_password and repeat_new_password to change their password through Supabase Auth.

</frozen-after-approval>

## Implementation Notes

- Small additive change to existing routes, UsersHandler, Supabase service, tests and README; no migrations, live data changes or deployment required.
- Reuse group resolution and verified identity middleware for both routes. Scope profile writes by auth_user_id and group_id; require membership before password updates.
- Follow existing partial-update conventions: at least one allowed profile field, trimmed nonempty names up to 255 characters, address up to 4000 characters or null to clear, omitted fields unchanged. Reject all unsupported fields.
- Passwords must match exactly, be at least 8 characters and at most 72 UTF-8 bytes, without trimming. Send only password to Supabase PUT /auth/v1/user with the caller's token and publishable key. Do not update local password hashes.
- Return the same safe user/group shape as GET for profile updates and a success message for password updates. Preserve sanitized provider errors, including weak/same-password and reauthentication requirements.
- Verify input boundaries, authorization, group isolation, non-mutation on rejected requests, Supabase request construction and errors, then run the full test suite. No live password changes in tests.
- Implemented both routes, strict profile/password validation, sanitized provider policy errors, safe response projection, documentation and regression tests.
- Review fixes count Unicode code points, reject malformed Unicode, set no-store before parser/group errors, and validate the provider's successful user response.
- Verification: npm test passed 68 tests; one existing PostgreSQL integration test skipped because TEST_DATABASE_URL is unset. Focused endpoint tests and git diff --check pass. No live Supabase password update or deployment performed.

## Review Triage Log

- Medium, patched: UTF-16 length accepted four emoji as an eight-character password and rejected valid names prematurely. Count code points and test supplementary-character boundaries.
- Medium, patched: malformed Unicode could be changed during UTF-8 encoding. Reject unpaired surrogates in profile/password inputs with tests.
- Low, patched: early JSON/group errors lacked the documented no-store header. Set it before parsing and assert it on every endpoint test response.
- Medium, patched: malformed successful provider responses could report success. Validate UUID shape as the existing getUser service does, with regression coverage.
- Low, rejected: no real PostgreSQL two-identity persistence test for the new routes. Existing tests assert the actual generated SQL contains both auth_user_id and group_id predicates, the verified identity binding, and a safe returning projection; no missing identity filter was found. A new database fixture requires infrastructure beyond a simple correction; the skipped existing integration test is disclosed.
