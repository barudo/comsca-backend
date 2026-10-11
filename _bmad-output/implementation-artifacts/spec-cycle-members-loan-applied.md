---
title: 'Include applied loan amount in cycle members'
type: 'feature'
created: '2026-10-11'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Include loan_applied in each member returned by GET /api/v1/cycles/members.

</frozen-after-approval>

## Implementation Notes

- Small reversible response extension. Existing numeric member fields establish a decimal-string amount contract. Use latest active application amount_desired for the member, group and returned cycle, or 0.00 when absent.
- Lateral lookup orders by created_at and id descending and limits to one row, avoiding duplicate members or inflated balances. Retain existing permissions and active/distributing cycle selection.
- Update README, local query assertions and PostgreSQL integration coverage for exact amounts, duplicate applications, deleted records, other cycles/groups and missing applications.
- Subagent review/testing omitted per session preference. No migration or deployment required.
- Verification: nine local tests passed; PostgreSQL integration test skipped because TEST_DATABASE_URL is unset. Local diff review and git diff --check passed with no deferred findings.
