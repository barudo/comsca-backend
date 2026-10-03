---
title: 'Create loan applications'
type: 'feature'
created: '2026-10-04'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add loan_applications migration and POST /api/v1/loan-apply. MEMBER supplies only amount_desired; OWNER/ADMIN/TREASURER supply user_id and amount_desired. Resolve member identity from auth and group, and latest nonclosed cycle on backend. Validate positive exact money and applicant group/cycle membership. Store amount_disbursed zero, active status, created_at/updated_at from server defaults. Status supports active/deleted. Keep implementation minimal and do not run tests.

</frozen-after-approval>

## Implementation Notes

- Added migration 029 with group-scoped foreign keys, cycle membership FK, numeric/status checks and RLS; not applied.
- Added handler, authenticated route and short README contract. Application creation does not post or disburse funds.
- No tests run per user instruction. Dates mean existing created_at/updated_at conventions; draft/active/distributing match current-cycle selection for applications, which do not write the ledger.

## Review Triage Log

- Independent code review found no concrete correctness defects. No tests executed. Whitespace diff check passed.
