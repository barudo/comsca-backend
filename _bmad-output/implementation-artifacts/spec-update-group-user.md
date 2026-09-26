---
title: 'Update group member profiles'
type: 'feature'
created: '2026-09-25'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement PUT /api/v1/groups/users/:id for OWNER/ADMIN updates to member profile fields.

</frozen-after-approval>

## Implementation Notes

- Reuse member creation validation with partial updates, optional null clearing, unchanged role and identity fields.
- Lock actor inside transaction; update target using both id and group_id; use safe returning projection and clock_timestamp.
- Profile-only phone/email edits do not alter Supabase credentials. No external calls or schema changes.
- Verify authorization, group isolation, invalid IDs/body, normalization, partial updates, safe responses and database errors.
