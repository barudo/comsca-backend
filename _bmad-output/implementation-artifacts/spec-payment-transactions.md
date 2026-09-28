---
title: 'Replace equity posting with payment transactions'
type: 'feature'
created: '2026-09-28'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Replace `POST /api/v1/transactions/equity` with `POST /api/v1/transactions/payments`. Create a PAYMENT header containing positive LOAN_PAYMENT, BUY_SHARE, and PENALTY_PAYMENT components. The frontend supplies the member's `user_id`. LOAN_PAYMENT applies to the combined principal and interest, rather than principal alone. Record each loan payment as one amount with no principal/interest split. Use client-selected debit/credit account IDs per entry, preserving the proposed explicit-account request format. Loans credit Loans Receivable (1100), which combines principal and accrued interest.

## Boundaries & Constraints

**Always:** Authenticate using the existing bearer middleware and resolve the group through x-group-slug. Preserve OWNER/ADMIN/TREASURER authorization, cross-group isolation, and account/cycle consistency. Require the frontend-supplied member `user_id` and verify that member belongs to the selected group and cycle. Use exact decimal arithmetic. Save the header, components, and balanced signed account postings atomically; return success only after commit. Preserve current support for group accounts and historical cycles unless explicitly changed.

**Never:** Apply migrations, deploy, mutate production data, invent loan amortization or share quantities, or add receipt-number allocation as part of this endpoint replacement. Existing schema already supports the discussed transaction and component types.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Authorized valid request | Existing group writer and references | 201 with transaction, entries, account_entries | Commit all rows together |
| Invalid input | Invalid IDs, nonpositive/excess-precision amount, unsupported fields | No writes | 400 |
| Unauthorized caller | Missing token, forbidden role, other-group user | No financial writes | 401/403 |
| Bad references | Missing/other-group account, cycle, member | No writes | 404 |
| Invalid scope | Mismatched cycles or unenrolled member | No writes | 400 |
| Commit failure | Constraint or concurrency failure | Full rollback | Sanitized 409 |
| Removed equity route | Authenticated request to old URL | No equity transaction created | 404 |

</frozen-after-approval>

## Code Map

- `src/routes/index.js` -- explicit route registry; replace equity route and handler binding.
- `src/handlers/equity-transactions.js` -- existing validation, financial role checks, shared row locks, cycle inference, membership validation, atomic writes and sanitized errors. Replace with payments handler after contract decisions.
- `migrations/005_create_transactions.js`, `018_scope_account_ledger.js`, `021_validate_account_entries_after_changes.js` -- existing flexible types and deferred exact balancing constraints; no schema changes needed.
- `migrations/019_seed_cycle_accounts.js` -- cash, loan/interest/penalty receivables, equity and income accounts. Penalty credit may settle a receivable or recognize income; do not silently pick an accounting treatment.
- `test/equity-transactions.test.js` -- request validation/authorization/rollback fixtures; adapt to agreed payments contract.
- `test/login.integration.test.js` -- real PostgreSQL endpoint persistence, precision, scoping, row-lock contention and immediate/deferred rollback coverage; preserve and extend for mixed components.
- `README.md` -- replace endpoint contract and examples.

## Tasks & Acceptance

**Execution:**
- [x] `src/handlers/payment-transactions.js` -- implement agreed payment request contract using existing transaction and scope guarantees; remove replaced equity handler.
- [x] `src/routes/index.js` -- expose payments and remove equity route.
- [x] `test/payment-transactions.test.js` -- adapt request suite and add component/type/total validation appropriate to agreed contract; remove replaced equity request suite.
- [x] `test/login.integration.test.js` -- adapt existing endpoint coverage and verify real mixed-component persistence and rollback if selected.
- [x] `README.md` -- document actual request shape, posting semantics, errors and removed route.

**Acceptance Criteria:**
- Given a valid authorized payment, when posted, then its header, components and balanced account postings commit together and retain exact monetary values.
- Given invalid references, scope, authorization or a commit-time failure, when posted, then no partial transaction persists.
- Given the replaced equity URL, when requested with valid group context, then no financial handler processes it.

## Implementation Notes

- Baseline revision: 35c20f0c4335904238aabed2d160f76d6f27b40f. Working tree was clean on main.
- Read-only schema investigation confirmed no migration is required. Receipt counters and document fields exist but the existing endpoint does not allocate them; allocation is outside the stated request.
- Open questions sent asynchronously while investigating schema and existing integration coverage.
- User confirmed frontend-supplied member user ID and that LOAN_PAYMENT covers principal plus interest. Updated the draft to capture those decisions. Source inspection found no loan-payment allocator; asked for the partial-payment allocation rule with a concrete example.

## Verification

- Run request/unit tests with `npm test`.
- Run existing integration suites against a fresh disposable local PostgreSQL instance, never configured application databases.
- Run `git diff --check` and review final changes.

- Implementation resumed on explicit user request. Required entries array has 1–100 entries; server derives the header amount using integer cents and rejects numeric(18,2) overflow. Each entry supplies type, debit, credit, amount and optional description. Loan credit must be account code 1100 ASSET; share credit EQUITY; penalty credit 1300 ASSET or 4100 INCOME. Debit must be ASSET. Existing explicit/inferred cycle and reference locking semantics remain. No receipt allocation or external deployment.

- Implemented payment handler and replaced equity route/handler. Updated request tests, real PostgreSQL integration tests, and README. Shared error middleware now returns 413 for bodies exceeding the existing 32 KiB parser limit.
- Final verification: 107 tests passed with zero skips/failures on a fresh disposable PostgreSQL 18 instance; `git diff --check` passed. Initial sandbox run could not bind test HTTP ports; complete suite passed with local test network permissions.

## Review Triage Log

- Medium: oversized documented batches returned 500 due to existing 32 KiB parser limit. Preserve the API limit, document the aggregate limit, return 413, and test no writes for oversized bodies.
- Low: cross-component cycle isolation lacked a regression. Added individually valid entries from distinct cycles; assert 400 and no writes.
- Low: later foreign-account rejection lacked coverage. Added valid first entry followed by inaccessible account; assert 404 and no writes.
- Low, rejected: separate membership-deletion race test. Existing FOR SHARE membership lock remains unchanged and normal missing-membership rejection is tested; role and account contention are already tested on real PostgreSQL. Additional race orchestration would duplicate unchanged locking behavior without a demonstrated defect.
- Low: new credit-code concurrency protection lacked coverage. Added concurrent Loans Receivable code mutation and verified waiting request rejects the updated code.
- Low: near-maximum exact multi-component sum lacked coverage. Added 9999999999999999.98 + 0.01 success assertion.
- Low: maximum batch only mock-tested. Added real 100-entry payment, with 100 components, 200 postings, and exact 1.00 total.
