---
title: 'Post a member loan disbursement'
type: 'feature'
created: '2026-09-28'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add POST /api/v1/transactions/disburse-loans accepting required member user_id, debit and credit account IDs, positive amount, optional cycle_id and description. Debit Loans Receivable (ASSET code1100), credit a distinct selected funding ASSET. Create one LOAN_DISBURSED header and component, matching the user's earlier balance formula, and balanced signed postings atomically. Require bearer authentication, group selection and OWNER/ADMIN/TREASURER authorization. Require member group/cycle membership; infer cycle from selected accounts or use explicit cycle, preserving existing group-account and historical-cycle semantics. Preserve exact numeric(18,2) money and existing validation, reference locks and sanitized errors. Return the persisted transaction, entries and account_entries only after commit. Include docs and a sample request. No schema migration, production deployment, interest accrual, voucher numbering or available-funds calculation is required.

</frozen-after-approval>

## Implementation Notes

- Existing payment handler provides matching authorization, scope, locking, decimal validation and response conventions. New dedicated handler limits the change to disbursement behavior.
- Existing schema permits LOAN_DISBURSED without migration. Historical LOAN_DISBURSEMENT records remain unchanged; no balance calculation endpoint is added here.
- Tests cover request validation and real PostgreSQL persistence and rollback.
