---
title: 'Accounting Balance Sheet Endpoint'
type: 'feature'
created: '2026-10-02'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The accounting API lacks a balance sheet for the authenticated group's active cycle, so users cannot inspect assets, liabilities, and equity or verify the accounting equation.

**Approach:** Add `GET /api/v1/accounting/balance-sheet`, deriving account balances directly from cycle-scoped journal postings. Return Assets, Liabilities, and Equity sections with their real accounts and section totals, plus overall totals and the signed difference. Assets use debit-normal balances; liabilities and equity accounts use credit-normal balances. Include current-cycle net earnings (income less expenses) as a separate derived Equity component so Assets equals Liabilities plus Equity before period closing. Use the established financial-role authorization and group/cycle scope.

</frozen-after-approval>

## Implementation Notes

- Added the authenticated balance-sheet route and handler using the existing financial-role authorization, active/distributing cycle selection, and read-only repeatable-read transaction pattern.
- Assets use debit-normal balances; liabilities, equity, and income use credit-normal balances; expenses use debit-normal balances. Current-cycle income less expenses is reported separately and included in total equity so the equation reconciles.
- Added focused route tests, extended the PostgreSQL dashboard integration fixture to verify journal-derived sections and current earnings, and documented the response contract in README.
- `npm test` passes 129 tests; 4 integration tests, including the PostgreSQL balance-sheet scenario, are skipped because `TEST_DATABASE_URL` is not configured.

## Review Triage Log

- `low` -- README did not document authentication failures; added 401/403 behavior.
- `low` -- README did not distinguish no current cycle from a current cycle with no accounts; documented both responses.
- `false` -- The reviewer read “active cycle” as excluding distributing. The handler follows the established current financial-cycle filter (`active`, `distributing`) used by the dashboard and trial balance.
- `low` -- Loss-side current earnings lacked coverage; added a loss case and verified negative earnings while the equation still reconciles.
- `false` -- The reviewer raised cacheability; `authenticate` sets `Cache-Control: no-store` on all protected routes, and the endpoint test now asserts the header.
