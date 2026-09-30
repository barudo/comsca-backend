---
title: 'Charge configured loan interest to cycle members'
type: 'feature'
created: '2026-09-29'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '16dff69c77436170bba1234e523e03cc927ceb67'
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The API stores cycle interest settings but does not calculate or post interest owed by cycle members with outstanding loans.

**Approach:** Add `POST /api/v1/interests/charge` accepting `{credit, debit}`. Use the current cycle's interest settings to calculate interest for members with loans owed, then atomically create a `LOAN_INTEREST` transaction, member entries, and corresponding debit/credit account entries using the supplied accounts.

**Agreed behavior:** Each POST charges one full configured period with no elapsed-time check or duplicate suppression; a repeated POST is another period. The rate is a percentage per period. SIMPLE uses outstanding principal; COMPOUND uses principal plus unpaid interest. Apply each `LOAN_PAYMENT` to accrued interest first, then principal. Round per member to cents using PostgreSQL numeric rounding and sum those rounded entries for the transaction amount. Accept distinct group/cycle-scoped accounts with an ASSET debit and INCOME credit. Include `LOAN_INTEREST` in `remaining_loan`. Return 409 without writes when no positive interest is chargeable.

## Boundaries & Constraints

**Always:** Use settings `interest_rate`, `interest_period`, and `interest_method` from the current active/distributing cycle. Reconstruct per-member principal and accrued interest from chronological loan ledger entries. Scope member, cycle, and account reads to the selected group. Persist one `LOAN_INTEREST` entry per borrower with positive rounded interest and balanced postings. Preserve exact decimal values and atomic rollback.

**Never:** Accrue partial periods, infer elapsed time, deduplicate repeated charge calls, or alter the agreed payment allocation, rounding, account-type, or member-balance rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Configured cycle with borrowers | `{credit, debit}` and positive rounded interest | Create a `LOAN_INTEREST` transaction, member entries, and balanced account postings | Commit all rows atomically |
| Missing interest settings | Current cycle has null interest terms | No financial rows are written | Reject with 409 |
| No positive charge | No positive loan or all member interest rounds to zero | No financial rows are written | Return 409 |

</frozen-after-approval>

## Code Map

- `src/handlers/cycles.js` validates and returns cycle rate, period, and method settings. Cycle financial settings become immutable after draft.
- `README.md` defines rates as percentages per period and SIMPLE as principal-only versus COMPOUND as principal plus unpaid interest; it explicitly leaves payment allocation, partial-period calculations, and rounding to the implementation design.
- `src/handlers/cycle-members.js` selects the current active/distributing cycle and calculates `remaining_loan`; update it to include `LOAN_INTEREST`.
- `src/handlers/payment-transactions.js` writes member `LOAN_PAYMENT` entries as a single unsplit amount.
- `migrations/007_add_cycle_financial_settings.js` defines settings; existing `LOAN_INTEREST` type is already used in ledger tests, so no schema change is presumed.
- `migrations/025_remove_interest_receivable_from_cycle_defaults.js` removes default account 1200; cycle defaults include Loans Receivable 1100 and Interest Income 4000.
- `src/routes/index.js` registers authenticated group-scoped financial routes.
- `test/login.integration.test.js` contains disposable-PostgreSQL ledger persistence and rollback coverage.

## Tasks & Acceptance

**Execution:**
- `src/handlers/interests.js` — calculate each member's period interest from chronological loan entries and post interest atomically.
- `src/routes/index.js` — register `POST /api/v1/interests/charge` behind existing authentication and group middleware.
- `test/interests.test.js` and `test/login.integration.test.js` — cover calculations, scoping, exact amounts, persistence, and atomic rollback.
- `src/handlers/cycle-members.js` and its tests — include `LOAN_INTEREST` in remaining loan balances.
- `README.md` — document the formula, frequency, account requirements, request, and errors.

**Acceptance Criteria:**
- Given a configured active/distributing cycle and eligible borrowers, when an authorized financial writer charges interest, then one full configured period is calculated per member and rounded entries and balanced postings commit atomically.
- Given interest-first loan payments and SIMPLE or COMPOUND settings, when interest is charged, then principal and unpaid interest produce the configured calculation base.
- Given missing settings, invalid accounts, no positive rounded interest, or a commit-time failure, when the endpoint is called, then no partial financial records persist and the agreed status is returned.

## Implementation Notes

## Verification

**Commands:**
- `node --test test/interests.test.js` — focused request and calculation tests pass.
- `npm test` — full suite passes; PostgreSQL integration status is reported accurately.
- Disposable PostgreSQL integration test — persisted records match the agreed calculations and failures leave no partial rows.