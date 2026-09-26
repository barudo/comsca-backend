---
title: 'Require the api/v1 prefix for all endpoints'
type: 'refactor'
created: '2026-09-26'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Remove all API endpoints that do not start with /api/v1. Retain existing versioned endpoint behavior and make endpoint naming consistent.

</frozen-after-approval>

## Implementation Notes

- Remove unversioned route aliases and the root welcome route from src/routes/index.js. No replacement welcome route is needed.
- Reject paths outside the /api/v1 namespace with 404 before parsing, CORS preflight handling or group/auth lookup in src/app.js; require a path-segment boundary.
- Migrate existing behavioral tests and README examples to versioned URLs. Add regression coverage that removed paths never invoke database or Auth services, including HEAD and OPTIONS.
- This is a bounded routing cleanup without unresolved intent gaps, migrations or deployment. Existing clients must switch to versioned URLs.

- Completed route alias removal, root handler deletion, migrated functional tests, removed-route regression coverage, and README/maintained documentation updates.
- CORS response headers run before prefix rejection, but successful preflight handling is restricted to the versioned namespace. This lets allowed browser clients read 404 errors without enabling removed routes.
- Verification: npm test passes 66 tests; one existing database integration test is skipped because TEST_DATABASE_URL is unset. No deployment or remote push performed.

## Review Triage Log

- Medium, patched: maintained cycle lifecycle and project context docs prescribed removed paths. Updated them to versioned endpoints.
- Medium, patched: the prefix guard prevented allowed-origin CORS headers on 404 responses. Apply headers first, restrict preflight success to versioned paths, and assert headers in the regression matrix.
- Low, patched: obsolete HomeHandler remained unused. Deleted it after checking references.
- Low, rejected: some positive-path test loops now have one route. They still exercise the correct behavior; broad flattening adds structural churn with negligible maintenance benefit. Test titles referring to removed dual paths were corrected.
