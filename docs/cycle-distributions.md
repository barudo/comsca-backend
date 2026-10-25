# Cycle distribution accounting

Declare with `PUT` or `PATCH /api/v1/cycles/:id` and `{ "status": "distributing" }`. Only OWNER/ADMIN can declare. `GET /api/v1/cycles/:cycleId/distributions` allows OWNER/ADMIN/TREASURER/AUDITOR in the selected group. Responses include cycle information, an exact-decimal summary and member records; amounts are strings to preserve precision.

Capital is the net member-attributed equity ledger amount identified by BUY_SHARE entries or an explicit MEMBER_CAPITAL account role. Contribution Income is earnings, not capital. Income less expenses is allocated in integer cents by capital, with largest remainders assigned first and member ID breaking ties. Losses reduce entitlements; losses larger than total capital require reconciliation.

Nonzero contributions, penalties, other unsupported receivables and negative loan balances block declaration. Loans Receivable (1100) is deducted up to each member's gross proceeds. Excess debt stays in the same receivable account; no negative payable is created. Current posting endpoints already restrict loan repayments to 1100. Legacy custom loan accounts require reconciliation rather than automatic deduction.

The declaration first closes income and expense balances to Retained Earnings. It then debits member equity and retained earnings (or reverses the earnings direction for losses), credits Member Distribution Payable, and debits that payable / credits Loans Receivable for the deduction. All writes and voucher counters commit together. No cash moves. A cash shortage produces a warning. Payouts and collecting residual loans after declaration are not implemented here.

## Accounts and reconciliation

Migration 037 adds `accounts.distribution_role` and the declaration/member tables with group RLS and guarded rollback. Required cycle accounts are reused by explicit role or recognized name, or created during declaration: 2100 Member Distribution Payable (LIABILITY), 3100 Retained Earnings (EQUITY). Recognized equivalents include Member Distributions Payable and Distributable Earnings. Conflicting codes/types or ambiguous matches fail without overwriting accounts.

The normal chart needs no manual setup. For custom/legacy charts, an authorized database operator must inspect member attribution and balances before classifying accounts. There is deliberately no public account-classification endpoint. Inspect `accounts` scoped by both `group_id` and `cycle_id`, plus `transaction_entries` member identity and linked `account_entries`. The role is visible directly in the database. Valid classifications are MEMBER_CAPITAL/EARNINGS for equity, DISTRIBUTION_PAYABLE for liabilities, and CASH/RECEIVABLE for assets. Never mark contributions, penalties or loans as cash to bypass validation. Resolve conflicts before declaration and retain a record of the reconciliation; do not edit original posted amounts. Unattributed member capital/receivables and unsupported nonzero balances are validation errors. Zero settled unsupported balances do not block.

There is no dispute flag in the existing schema; disputed balances must be resolved operationally before declaration. An already-distributing legacy cycle with no declaration returns a conflict and needs an explicit reconciliation/migration plan; it is never recalculated silently.

Business mutations are blocked while distributing, including payments, charges, donations, expenses, loan applications, membership additions, counters and transaction voids. Reads and explicit closing remain available. Closing does not pay members or clear residual loans. Stored declarations are immutable in this release; payout support will require a follow-up schema change for payment state.

## Verification

Use a dedicated disposable PostgreSQL instance for `TEST_DATABASE_URL` and run `node --test test/cycle-distributions.test.js test/cycle-distributions.integration.test.js`. The integration fixture creates/drops its own database and uses the real accounting migrations/constraints. Production migrations are not run by tests.
