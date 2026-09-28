---
title: 'Remove Interest Receivable from cycle activation defaults'
type: 'chore'
created: '2026-09-28'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add migration 025 replacing the cycle account seed function so activation creates ten default accounts without Interest Receivable (1200). Keep Loans Receivable and Interest Income. Preserve all existing accounts and postings. Retain idempotence and reserved-account compatibility validation. Rollback restores the eleven-account seed template without bulk backfill. Verify with disposable PostgreSQL migration tests and update the documented default chart. Do not apply to production or change payment endpoints as part of this migration request.

</frozen-after-approval>

## Implementation Notes

- Existing migration 019 creates the seed function used by the activation trigger. A new migration replaces only that function; historical migrations remain unchanged.
- The pre-existing untracked payment spec is ongoing work from this session and is outside this change.
- Migration defines its own fixed chart to keep future migrations from altering rollback behavior.
- Added migration 025, updated the documented default chart, and extended PostgreSQL integration coverage for activation, existing interest postings, idempotence, reserved-code conflicts, and rollback.
- Final verification on a fresh disposable PostgreSQL 18 container: 101 tests passed, zero failures or skips; `git diff --check` passed. Production migrations were not run.
- Initial full-suite run exposed an obsolete 22-account expectation for two cycles; corrected to 20. A fresh database on the same test server retained cluster-wide roles, so final verification used a newly created container.

## Review Triage Log

- Low: test complete account definitions, not only count/absence. Added exact tuple comparisons against the original chart minus 1200, and full original chart after rollback.
- Low: exercise reseeding an existing cycle with historical interest postings. Added exact account/posting preservation assertions after calling the replacement function.
- Low: cover activation of a draft already containing 1200. Added test verifying the existing row remains unchanged while ten defaults are seeded.
- Low: clarify rollback's effect on later existing-cycle status updates. Added README explanation and test showing later seeding restores 1200.
- All findings addressed; nothing deferred.
