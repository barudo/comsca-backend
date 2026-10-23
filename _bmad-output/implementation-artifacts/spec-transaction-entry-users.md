---
title: 'Include user profiles in transaction entries'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Join transaction entries to users by user_id and return user information in the entries endpoint.

</frozen-after-approval>

## Implementation Notes

- Small additive change, no intent gaps or irreversible operations. Use a same-group left join to retain entries without users and a nested user object to avoid column collisions.
- Match the group-user-list profile allowlist, excluding credentials and auth identifiers. Select scalar columns to preserve bigint strings through pg.
- Updated handler, endpoint tests and README. Retain OWNER/ADMIN access and parent transaction scope.
- Verification: full suite 194 passed, 5 skipped; focused six tests passed after review coverage improvements.

## Review Triage Log

- Low, patched: assert every projected user column and alias so fixture output cannot mask missing selections.
- Low, patched: cover unmatched non-null user_id with all joined columns null and verify alias removal.
- False: a live cross-group user reference fixture is prohibited by migration 027's composite (group_id, user_id) foreign key. The join additionally enforces group equality, verified in SQL assertions. No runtime defect or deferred work.
