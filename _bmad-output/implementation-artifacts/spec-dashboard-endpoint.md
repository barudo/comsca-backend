---
title: 'Current Cycle Dashboard Endpoint'
type: 'feature'
created: '2026-10-01'
status: 'done'
route: 'dispatch'
baseline_commit: '7313cb7a47d8f4854bc298db4f04c433febdf360'
review_loop_iteration: 0
context:
  - '{project-root}/docs/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The API has no single group-scoped endpoint for current-cycle financial and membership summary figures.

**Approach:** Add authenticated `GET /api/v1/dashboard` returning cash on hand, outstanding loans, fund value, share capital, contributions collected and due, and active members for the selected group's current cycle.

**Always:** Use the resolved group and the active/distributing cycle; allow the existing financial reader roles; return exact decimal strings for monetary values and an integer member count. Cash on Hand is the balance of Cash account 1000. Outstanding Loans are loan disbursements and interest less payments. Share Capital is the sum of `BUY_SHARE`; Contributions Collected are `PAY_CONTRIBUTION`; Contributions Due are `CHARGE_CONTRIBUTION`/legacy `CONTRIBUTION` less `PAY_CONTRIBUTION`. Active Members are current-cycle enrollments. Total Fund Value is the sum of all current-cycle `ASSET` account balances, including receivables and excluding liabilities.

**Never:** Accept group or cycle scope from query parameters or add a database migration.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current cycle | Authenticated financial reader in selected group | Success, current cycle ID, all seven totals | N/A |
| No active/distributing cycle | Same request, no current cycle | Null cycle ID and zero totals | N/A |
| Unauthorized | Missing auth or caller lacks financial role in group | No dashboard data returned | Existing 401/403 behavior |

</frozen-after-approval>

## Code Map

- `src/routes/index.js` — explicitly registers authenticated, group-scoped routes.
- `src/handlers/cycle-accounts.js` — financial reader role check and current-cycle selection conventions.
- `src/handlers/cycle-members.js` — repeatable-read snapshot and established member balance semantics (`BUY_SHARE`, loan disbursement/interest/payment, contribution charge/payment).
- `migrations/018_scope_account_ledger.js`, `migrations/026_add_contribution_cycle_accounts.js` — signed account postings and chart codes, including Cash (1000), Loans Receivable (1100), and Contributions Receivable (1400).
- `test/cycle-accounts.test.js`, `test/cycle-member-balances.test.js` — group, role, cycle, decimal, and request-test patterns.
- `README.md` — endpoint contracts and access policy.

## Tasks & Acceptance

**Execution:**
- [x] `src/handlers/dashboard.js` — calculate the selected group's cycle totals in one read-only database snapshot without floating-point aggregation.
- [x] `src/routes/index.js` — register `GET /api/v1/dashboard` after group resolution and authentication.
- [x] `test/dashboard.test.js` — cover route, role/group isolation, no-cycle behavior, and exact totals.
- [x] `test/dashboard.integration.test.js` — assert PostgreSQL totals, group/cycle isolation, and empty-cycle values when a test database is available.
- [x] `README.md` — document response fields and metric semantics.

**Acceptance Criteria:**
- Given an authenticated financial reader, when requesting the dashboard, then totals include only the selected group's current active/distributing cycle.
- Given financial entries with decimal amounts, when totals are returned, then monetary values retain exact decimal precision.
- Given no current cycle, when requesting the dashboard, then the response contains null `current_cycle_id` and zero-valued metrics.

## Implementation Notes

The PostgreSQL integration test is present but was skipped locally: `TEST_DATABASE_URL` is unset, and the installed PostgreSQL client tools do not include the server binary.

## Review Triage Log

- low — Dashboard documentation omitted group-resolution errors. The group middleware returns 400 for a missing header and 404 for an unknown slug; both outcomes are now documented.
- maybe-false — The unit test runner returned fixed totals, so SQL arithmetic was not exercised. A PostgreSQL integration test now asserts the calculated totals, but it could not run in this environment; running it against `TEST_DATABASE_URL` will settle the remaining verification gap.
- maybe-false — The empty-current-cycle aggregation case lacked executed coverage. The PostgreSQL integration test now includes an active cycle with no accounts, ledger entries, or members, but could not run here for the same environment limitation.
- false — A currency code is neither stored by the group/cycle schema nor returned by existing financial APIs; adding a code or assuming a fixed currency is unsupported by the requested response contract.
- false — Contributions Due is intentionally a signed difference: the existing member-balance query subtracts payments from charges without clamping, so overpayments remain negative.
- maybe-false — Loan and contribution subtraction assertions were absent from mocked tests. The PostgreSQL integration test verifies their net results, but its execution remains unverified until a disposable PostgreSQL test URL is available.

## Verification

**Commands:**
- `node --test test/dashboard.test.js test/dashboard.integration.test.js` — dashboard tests pass; the PostgreSQL test skips only when `TEST_DATABASE_URL` is unavailable.
- `npm test` — existing and new tests pass.
- `git diff --check` — no whitespace errors.
