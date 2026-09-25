---
title: 'Accept new fields when creating cycles'
type: 'feature'
created: '2026-09-25'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Update the existing POST /cycles endpoint and its alias to accept and return name, description, absence_penalty, and required_monthly_contribution.

</frozen-after-approval>

## Implementation Notes

- Existing handler and validation in src/handlers/cycles.js; routes already registered.
- Scope creation fields separately from shared PATCH/list selections to preserve existing behavior and reader column permissions.
- Nullable text fields follow migrations 014/015. Name is at most 255 Unicode characters; reject non-string text and NUL characters. Currency uses existing decimal validation with zero allowed.
- No database execution or irreversible actions. Verify creation, validation, aliases and regressions with existing tests.
- Implemented creation-only validation and response columns; updated README and tests. Full suite: 55 passed, 1 skipped. SQL-backed RLS integration test remains skipped without its database configuration.
- Independent review found no concrete defects. No findings deferred.
