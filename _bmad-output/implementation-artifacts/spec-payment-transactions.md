---
title: 'Replace equity posting with payment transactions'
type: 'feature'
created: '2026-09-28'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Replace `POST /api/v1/transactions/equity` with `POST /api/v1/transactions/payments`. Create a PAYMENT header containing positive LOAN_PAYMENT, BUY_SHARE, and PENALTY_PAYMENT components. The frontend supplies the member's `user_id`. LOAN_PAYMENT applies to the combined principal and interest, rather than principal alone. Resolve the remaining allocation and account-selection questions before implementing those posting rules.

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

## Open Questions

- For mixed components, client-selected debit/credit IDs per entry (preserves existing explicit-account workflow) or backend-selected accounts (requires defining account mappings)?
- How should a partial LOAN_PAYMENT split between principal and interest: interest first, proportionally, or an explicit frontend-supplied split? The repository contains cycle interest settings and ledger accounts but no implemented loan accrual or payment-allocation service. Automatic allocation also needs an agreed source for the outstanding amounts; do not invent accrued balances from rate settings alone.

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
- [ ] `src/handlers/payment-transactions.js` -- implement agreed payment request contract using existing transaction and scope guarantees; remove replaced equity handler.
- [ ] `src/routes/index.js` -- expose payments and remove equity route.
- [ ] `test/payment-transactions.test.js` -- adapt request suite and add component/type/total validation appropriate to agreed contract; remove replaced equity request suite.
- [ ] `test/login.integration.test.js` -- adapt existing endpoint coverage and verify real mixed-component persistence and rollback if selected.
- [ ] `README.md` -- document actual request shape, posting semantics, errors and removed route.

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
