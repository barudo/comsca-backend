# Cycle distribution accounting

Declare with `PUT` or `PATCH /api/v1/cycles/:id` and `{ "status": "distributing" }`. Only OWNER/ADMIN can declare. `GET /api/v1/cycles/:cycleId/distributions` allows OWNER/ADMIN/TREASURER/AUDITOR in the selected group. Responses include cycle information, an exact-decimal summary and member records; amounts are strings to preserve precision.

Capital is the net member-attributed equity ledger amount identified by BUY_SHARE entries or an explicit MEMBER_CAPITAL account role. Contribution Income is earnings, not capital. Income less expenses is allocated in integer cents by capital, with largest remainders assigned first and member ID breaking ties. Losses reduce entitlements; losses larger than total capital require reconciliation.

Nonzero contributions, penalties, other unsupported receivables and negative loan balances block declaration. Loans Receivable (1100) is deducted up to each member's gross proceeds. Excess debt stays in the same receivable account; no negative payable is created. Current posting endpoints already restrict loan repayments to 1100. Legacy custom loan accounts require reconciliation rather than automatic deduction.

The declaration first closes income and expense balances to Retained Earnings. It then debits member equity and retained earnings (or reverses the earnings direction for losses), credits Member Distribution Payable, and debits that payable / credits Loans Receivable for the deduction. All writes and voucher counters commit together. No cash moves. A cash shortage produces a warning. Member payouts are recorded separately as described below. Collecting residual loans after declaration is not implemented.

## Accounts and reconciliation

Migration 037 adds `accounts.distribution_role` and the declaration/member tables with group RLS and guarded rollback. Required cycle accounts are reused by explicit role or recognized name, or created during declaration: 2100 Member Distribution Payable (LIABILITY), 3100 Retained Earnings (EQUITY). Recognized equivalents include Member Distributions Payable and Distributable Earnings. Conflicting codes/types or ambiguous matches fail without overwriting accounts.

The normal chart needs no manual setup. For custom/legacy charts, an authorized database operator must inspect member attribution and balances before classifying accounts. There is deliberately no public account-classification endpoint. Inspect `accounts` scoped by both `group_id` and `cycle_id`, plus `transaction_entries` member identity and linked `account_entries`. The role is visible directly in the database. Valid classifications are MEMBER_CAPITAL/EARNINGS for equity, DISTRIBUTION_PAYABLE for liabilities, and CASH/RECEIVABLE for assets. Never mark contributions, penalties or loans as cash to bypass validation. Resolve conflicts before declaration and retain a record of the reconciliation; do not edit original posted amounts. Unattributed member capital/receivables and unsupported nonzero balances are validation errors. Zero settled unsupported balances do not block.

There is no dispute flag in the existing schema; disputed balances must be resolved operationally before declaration. An already-distributing legacy cycle with no declaration returns a conflict and needs an explicit reconciliation/migration plan; it is never recalculated silently.

Except for member payouts, business mutations are blocked while distributing, including loan/share payments, charges, donations, expenses, loan applications, membership additions, counters and transaction voids. Reads and explicit closing remain available. Closing does not pay members or clear residual loans. Declared entitlements remain immutable; migration 038 allows only payment progress to change.

## Verification

Use a dedicated disposable PostgreSQL instance for `TEST_DATABASE_URL` and run `node --test test/cycle-distributions.test.js test/cycle-distributions.integration.test.js`. The integration fixture creates/drops its own database and uses the real accounting migrations/constraints. Production migrations are not run by tests.

## Member payouts

Apply migration `038_create_member_payouts.js` before using these routes. Both require bearer authentication and `x-group-slug`.

- `POST /api/v1/cycles/:cycleId/payouts`: OWNER, ADMIN or TREASURER; cycle must be `distributing`.
- `GET /api/v1/cycles/:cycleId/payouts`: those roles plus AUDITOR; history remains available after closing. Returns `{ "success": true, "cycle": { "id": "1", "status": "distributing" }, "payouts": [...] }` in ascending payout ID order. An existing cycle with no payouts returns an empty array.

Example POST body:

```json
{
  "user_id": "5",
  "credit": "12",
  "amount": "250.00",
  "idempotency_key": "cycle-1-member-5-payment-1"
}
```

`user_id` identifies the member's declared distribution. `credit` is the same-cycle cash funding account: an ASSET explicitly classified CASH, or unclassified account code 1000. Receivable accounts cannot fund payouts. The API derives the debit from the member's declared Distribution Payable account. Amounts must be positive with at most two decimals; send decimal strings to preserve precision. Partial payments are supported up to the remaining entitlement and available funding balance. Unknown fields are rejected.

A successful payment returns HTTP 201 with `{ "success": true, "payout": {...}, "distribution": {...}, "transaction": {...} }`. The payout contains its ID, group/cycle/member IDs, transaction ID, debit and credit account IDs, amount, idempotency key and timestamp. The distribution reports cumulative `paid_amount` and status `partial` or `paid` (`pending` before any payment). The transaction uses type MEMBER_PAYOUT and a numbered DISBURSEMENT_VOUCHER. Journal postings, payout history, progress and voucher numbering commit together.

Use a distinct `idempotency_key` for each intended payment and reuse it when retrying that payment. Keys are 1–128 printable ASCII characters, scoped to the cycle. The same key and normalized member/account/amount return HTTP 200 with the original payout and transaction plus current distribution progress; a different payload returns 409. All POST requests, including retries, return 409 after closing. GET can confirm historical payments then.

Errors: 400 malformed input or unsuitable account classification; 401 missing/invalid authentication; 403 unauthorized role; 404 missing or foreign cycle/member/account; 409 wrong lifecycle, overpayment, insufficient cash or conflicting retry. Concurrent requests cannot exceed entitlement or cash. There is no payout edit/delete/void endpoint.

Distribution retrieval now derives `summary.total_paid` from current member payment progress. The declaration's `cash_available`, `cash_shortfall`, `warnings` and entitlement totals remain snapshots at declaration time, not live cash reports. Closing still records manager confirmation without checking all payouts are complete.
