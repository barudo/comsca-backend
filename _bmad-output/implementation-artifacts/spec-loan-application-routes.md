---
title: 'Add managed and self-service loan application routes'
type: 'feature'
created: '2026-10-10'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add POST /api/v1/loans/apply accepting user_id and amount_desired for OWNER,
ADMIN and TREASURER, and POST /api/v1/me/loans/apply accepting amount_desired
for all authenticated group roles. Record applications in loan_applications.
No subagent testing is required.

</frozen-after-approval>

## Implementation Notes

- Reuse the existing transaction, money validation, group and current-cycle membership checks and database defaults; retain the legacy endpoint contract.
- New explicit handler entry points choose managed or self application mode. Self mode includes AUDITOR and rejects user_id overrides.
- Update route registration and README; no schema changes or external actions needed.
- No unresolved intent gaps; small reversible handler, routes, documentation and local test footprint.
- Verification: all four local HTTP tests in test/loan-applications.test.js pass, covering role access, caller identity, validation, membership and legacy compatibility. Database queries use the repository's mocked Knex runner convention; no live database was used.
- Local diff review and whitespace check passed. Subagent review/testing skipped per user preference; no deferred findings.
