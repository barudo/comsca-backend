---
title: 'Accounting Trial Balance Endpoint'
type: 'feature'
created: '2026-10-02'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The accounting API has no trial balance for the authenticated group's active cycle, making it difficult to inspect per-account debits, credits, and net balances.

**Approach:** Add `GET /api/v1/accounting/trial-balance` to calculate account totals directly from signed journal postings. Return each account's ID, code, name, type, total debits, total credits, debit balance, and credit balance, with summary debit/credit balance totals and their signed difference. Scope the read to the selected group and active/distributing cycle, and apply the established financial-role authorization.

</frozen-after-approval>

## Implementation Notes

- `account_entries.amount` is positive for debits and negative for credits; link through `transaction_entries` and `transactions` to enforce selected-cycle scope.
- Account debit/credit balances are the positive net side: debit balance is `max(total_debits - total_credits, 0)`, credit balance is `max(total_credits - total_debits, 0)`.
- Summary totals sum the per-account debit and credit balance columns; difference is total debits minus total credits. A balanced ledger therefore returns equal totals and zero difference.
- Reuse the accounting accounts handler's financial-role gate, cycle filter, and repeatable-read read-only transaction. Do not persist calculated balances or add migrations.
- Added the `/api/v1/accounting/trial-balance` route and handler, plus focused tests for balanced totals, normal-side balances, authorization, group/cycle scope, and no active cycle.
- Documented the endpoint and extended the PostgreSQL dashboard integration fixture to exercise actual journal aggregation, including an unused account and cycle/group isolation.
- The PostgreSQL-backed assertion is skipped locally because `TEST_DATABASE_URL` is not configured.

## Review Triage Log

- `low` -- README lacked this endpoint's response contract; added the route, fields, totals, and empty-cycle behavior.
- `medium` -- mocked rows could not verify SQL arithmetic; extended the PostgreSQL integration fixture to assert gross postings, net balances, summary equality, and scope.
- `low` -- zero-activity seeded accounts were not covered; integration coverage now verifies an unused account is returned with zero values.
- `low` -- financial-role allowlist was only partly covered; unit tests now verify OWNER, ADMIN, TREASURER, and AUDITOR access.
