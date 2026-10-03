---
title: 'Record incurred unpaid expenses'
type: 'feature'
created: '2026-10-03'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement POST /api/v1/transactions/add-expense with required positive exact-decimal amount, nonblank description, distinct debit/credit IDs owned by the selected group and current writable cycle. Debit must be EXPENSE and credit LIABILITY (including Accounts Payable). Authorize OWNER/ADMIN/TREASURER from the scoped database user. Follow existing active/distributing cycle eligibility and database server timestamps, without Manila conversion.

Create an EXPENSE header, one EXPENSE business component, and its equal positive expense debit and negative liability credit atomically. This follows the migrated ledger: transaction_entries are business components, while account_entries are debit/credit sides. No cash posting or disbursement. Return HTTP 201 with transaction, entries, account_entries after commit; follow existing sanitized errors.

</frozen-after-approval>

## Implementation Notes

- No unresolved intent gaps or irreversible changes; no schema migration. Extract the existing donation handler's scoped validation and posting pipeline for reuse by donation and expense handlers, retaining donation behavior.
- Register the authenticated route, document the contract, and cover success, validation, scopes, roles, cycles, rollback, and unchanged cash in route/integration tests.
