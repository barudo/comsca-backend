---
title: 'Persist member and cycle on loan disbursement entries'
type: 'bugfix'
created: '2026-09-29'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Loan disbursement transaction entries omit the member and cycle identifiers even though both are validated and stored on the transaction header.

**Approach:** Persist the validated `user_id` and resolved `cycle_id` on the `transaction_entries` row and cover both fields in the existing endpoint test.

</frozen-after-approval>

## Implementation Notes

- Added the validated member and resolved cycle IDs to the loan disbursement entry insert.
- Extended the existing endpoint test to assert both persisted entry fields.

## Review Triage Log

- low — Set the spec status to `done` after implementation and verification.
