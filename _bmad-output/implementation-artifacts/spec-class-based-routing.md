---
title: 'Consolidate routing with class-based request handlers'
type: 'refactor'
created: '2026-09-23'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Replace the mixed filesystem-loaded and manually mounted routes with one explicit route registry in `src/routes/index.js`. Move existing endpoint implementations into named handler classes in `src/handlers`, including cycle list/create/update methods. Preserve all existing URL aliases, methods, responses, validation, authorization, dependency injection, and middleware ordering. Remove the obsolete `src/api` loader and modules.

</frozen-after-approval>

## Implementation Notes

- No intent gaps or irreversible operations. This is a bounded mechanical extraction of existing endpoint bodies with no new public API or database changes; use the oneshot path.
- Registry order must retain CORS before parsing; raw webhook parsing before JSON; public registration, slug checks and Supabase auth before group resolution; tenant routes, root and legacy username login after group resolution.
- Handler instances must not retain request state. Dependencies stay in `request.app.locals` so test apps and Lambda invocations remain isolated.
- Existing HTTP tests cover cycle validation, role checks, aliases, registration, auth, webhook signatures and errors. Add focused routing regression coverage for middleware boundaries and per-app isolation, and run `npm test`.
- Implemented eleven handler classes, a single explicit registry, and one app-level router mount. Removed the filesystem loader and old route modules. Updated README and project orientation with the new layout.
- Added regression tests for public versus group-scoped auth, unknown-route behavior, and concurrent requests across separately injected apps. All 13 mechanically extracted endpoint bodies match the original logic after whitespace normalization; Supabase action methods retain the shared response/error behavior through `respond`.
- Verification: `npm test` passed 50 tests with zero failures; the PostgreSQL integration test was skipped because `TEST_DATABASE_URL` is not configured. The first sandboxed run could not bind local HTTP ports; rerunning with approved local port access passed. `git diff --check` passed.
- Review found a real automatic OPTIONS regression when flattening public routes. Public registrations now complete inside a child router in the same registry before the group gate; no-Origin OPTIONS behavior is covered for every public endpoint and for protected routes.
- Strengthened routing tests with a controlled async barrier, separate database injections, irrelevant group headers on public auth, unknown public namespace children, HEAD behavior, and response-header assertions. Clarified the legacy auth exception in README.
- Final verification: `npm test` passed 53 tests, zero failures, one optional PostgreSQL integration test skipped; `git diff --check` passed.

## Review Triage Log

- Medium, patched: public no-Origin OPTIONS previously reached the group gate after flattening; a public child router now completes automatic method discovery first. Regression test verifies status and Allow headers.
- Low, rejected: mounted root routes happened to accept a repeated trailing slash (e.g. `/api/v1/auth//`); normal endpoint paths and a single trailing slash remain supported. Reproducing incidental malformed-path behavior would require special matching rules across multiple roots and adds maintenance without a documented client requirement.
- Low, patched: service isolation test did not force overlap; a controlled barrier now holds all three requests in service calls before release.
- Low, patched: database isolation lacked focused coverage; distinct app database stubs now assert both group resolution and protected user lookup.
- Low, patched: public boundary test omitted irrelevant group headers; it now exercises nonexistent and invalid values without database access.
- Low, patched: unknown-route test omitted former public mount children; auth, hooks and user namespace fallthrough are now tested.
- Low, patched: HEAD compatibility lacked coverage; representative public and group-scoped endpoints compare status/headers with GET and assert an empty body.
- Low, patched: request helper dropped response headers; it now exposes them for Allow, cache and content assertions.
- Low, patched: README wording implied all auth was public; it now names Supabase auth and explicitly states the legacy group-header requirement.
