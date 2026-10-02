---
title: 'Accounting Income Statement Endpoint'
type: 'feature'
created: '2026-10-02'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cfdb164325b4aa9ea9282ab16858e45605e43657'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The accounting API has no income statement for the authenticated group's active cycle, preventing financial readers from inspecting income, expenses, and net income over a selected period.

**Approach:** Add `GET /api/v1/accounting/income-statement`, deriving per-account amounts and totals from cycle-scoped journal postings. Return Income and Expenses sections with account ID, code, name, amount, and section total, plus total income, total expenses, and net income. Optional `from` and `to` date bounds filter transactions by their business `occurred_at`, use inclusive calendar dates in Asia/Manila time, and further restrict results to the selected active/distributing cycle; absent bounds include all journal entries associated with that cycle. Use existing financial-role authorization, explicit group/cycle predicates, and a read-only repeatable-read transaction. Persist no calculated totals.

## Boundaries & Constraints

**Always:** Include zero-posting INCOME/EXPENSE accounts; calculate income as credit-normal and expenses as debit-normal amounts; preserve monetary precision as decimal strings; enforce the selected group and active/distributing cycle regardless of client-supplied group/cycle parameters.

**Never:** Read transaction `created_at` as the financial date, include another group's/cycle's entries, or store calculated totals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current cycle | No date bounds | Include all journal amounts attached to the selected active/distributing cycle | N/A |
| Date range | `from` and/or `to` in `YYYY-MM-DD` | Apply inclusive Asia/Manila calendar-date bounds to `occurred_at` within the current cycle | N/A |
| Invalid range | Malformed date or `from` after `to` | Do not query statement rows | HTTP 400 |
| No active cycle | No selected active/distributing cycle | Empty sections and zero totals; `current_cycle_id` is null | N/A |

</frozen-after-approval>

## Code Map

- `src/handlers/accounting-trial-balance.js` -- reuse the financial-role gate, active/distributing-cycle selection, repeatable-read transaction, and journal joins; it demonstrates the sign convention for debit/credit postings.
- `src/handlers/accounting-balance-sheet.js` -- reuse the account-entry aggregation and credit/debit normal-balance conventions; limit output to INCOME and EXPENSE.
- `src/routes/index.js` -- register the authenticated versioned GET route.
- `migrations/005_create_transactions.js` -- `transactions.occurred_at` is the financial timestamp and is indexed by group; cycle has no explicit start/end dates.
- `test/dashboard.integration.test.js` -- existing disposable-PostgreSQL ledger fixture for actual aggregation and group/cycle isolation.

## Tasks & Acceptance

**Execution:**
- [x] `src/handlers/accounting-income-statement.js` -- implement authorization, date validation/filtering, journal aggregation, and response shaping.
- [x] `src/routes/index.js` -- register the authenticated income-statement route.
- [x] `test/accounting-income-statement.test.js` and `test/dashboard.integration.test.js` -- verify date bounds, totals, zero-posting accounts, and scope.
- [x] `README.md` -- document query dates, response shape, authorization, and defaults.

**Acceptance Criteria:**
- Given a selected cycle with balanced postings, when the endpoint is called without dates, then it returns all cycle INCOME/EXPENSE accounts and computes net income as total income minus total expenses.
- Given valid date bounds, when the endpoint is called, then only postings whose `occurred_at` falls within those inclusive dates are aggregated.
- Given a non-financial role or a foreign group, when the endpoint is called, then access is denied before statement rows are read.
- Given invalid dates or a reversed range, when the endpoint is called, then it returns HTTP 400 without querying statement rows.

## Implementation Notes

- Added the authenticated income-statement endpoint with credit-normal income, debit-normal expenses, current-cycle scoping, and inclusive Asia/Manila `occurred_at` date filters.
- Added unit coverage for totals, authorization, invalid/reversed dates, leap-day validation, and each optional bound; extended PostgreSQL fixture coverage for cycle totals and one-sided date filters.
- The PostgreSQL-backed integration test is skipped locally because `TEST_DATABASE_URL` is not configured.

## Review Triage Log

- `false` -- “Active cycle” does not exclude distributing cycles in this API: the established financial endpoints select both `active` and `distributing`, and the lifecycle defines distributing as current until closed.
- `low` -- README omitted ordering; documented code-then-ID ordering, matching the SQL `ORDER BY`.
- `low` -- README example did not demonstrate zero-posting accounts; added a zero-amount income account to the example.
- `false` -- The I/O matrix says `from` and/or `to`, which covers each one-sided bound; unit and PostgreSQL fixture cases now cover each independently.
- `medium` -- One-sided date-filter results lacked PostgreSQL assertions; extended the ledger integration fixture to verify both `from`-only and `to`-only totals. Live database execution remains unverified locally without `TEST_DATABASE_URL`.
- `low` -- Date validation lacked leap-day coverage; added a valid leap day and an invalid non-leap February 29 case.
- `defer` -- The default suite skips PostgreSQL coverage without `TEST_DATABASE_URL`; the repository has no CI workflow to configure, so making database integration mandatory requires separate test-infrastructure work. See deferred-work entry.

## Design Notes

## Verification

**Commands:**
- `node --test test/accounting-income-statement.test.js test/dashboard.integration.test.js` -- focused tests pass; PostgreSQL coverage runs when `TEST_DATABASE_URL` is configured.
- `npm test` -- full backend suite passes.
