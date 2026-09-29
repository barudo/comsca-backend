---
title: 'List current cycle members and balances'
type: 'feature'
created: '2026-09-29'
status: 'in-progress'
baseline_commit: 'c9b391906971a4874e8cb6ac3681375df7677748'
route: 'dispatch'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Provide GET /api/v1/cylces/members to return group members for the current active or distributing cycle with total shares, remaining loan, total unpaid penalty, and total unpaid contribution.

## Boundaries & Constraints

Require bearer authentication and the existing x-group-slug scope. Preserve payment account-code restrictions and all existing write behavior. Exclude draft and closed cycles from current-cycle selection. Scope every ledger lookup to the selected group and cycle. Preserve decimal precision. Include only members enrolled in the selected cycle and include their user information (id, group_id, first_name, family_name, username, email, phone, address, role, created_at, updated_at); never expose credentials or auth identifiers.

Return success, current_cycle_id, and members. Each member includes user fields and decimal-string balances: total_shares = SUM(BUY_SHARE); remaining_loan = SUM(LOAN_DISBURSED) - SUM(LOAN_PAYMENT); unpaid_penalties = SUM(CHARGE_PENALTY) - SUM(PENALTY_PAYMENT); unpaid_contributions = SUM(CHARGE_CONTRIBUTION) - SUM(PAY_CONTRIBUTION). These are transaction entry amounts, not account postings. Preserve signed differences (no clamping). Legacy CONTRIBUTION entries from this charge handler also count as contribution charges. Resolve member identity via entry user_id with parent user_id fallback; scope cycle by transaction cycle_id. Only OWNER, ADMIN, TREASURER, AUDITOR can read the report. Both requested typo path and canonical cycles path are supported.

## I/O & Edge-Case Matrix

| Scenario | State | Behavior |
|---|---|---|
| Current cycle | Active or distributing cycle exists | Return current_cycle_id and members with balances |
| No current cycle | Only draft/closed cycles or none | Return current_cycle_id: null and members: [] |
| No postings | Included member has no ledger activity | Return zero balances |
| Access denied | Caller lacks financial reporting role in group | Return 403 |
| Missing authentication | No valid bearer token | Return 401 |

</frozen-after-approval>

## Code Map

- `src/handlers/cycle-members.js`: existing enrollment handler; add list method.
- `src/handlers/cycle-accounts.js`: financial read authorization and current cycle response conventions.
- `src/handlers/group-user-list.js`: member name fields and stable sorting.
- `src/handlers/loan-disbursements.js`: member identity resides on transaction header.
- `src/handlers/contributions.js`, `src/handlers/payment-transactions.js`: contribution and payment identities on entries.
- `migrations/018_scope_account_ledger.js`: signed account postings and ledger schema.
- `migrations/026_add_contribution_cycle_accounts.js`: receivable codes 1100, 1300, 1400 and equity account defaults.
- `src/routes/index.js`: route registration.

## Tasks & Acceptance

- [ ] `src/handlers/cycle-members.js`: implement group-authorized list and decimal SQL aggregation.
- [ ] `src/routes/index.js`: register requested spelling plus canonical /api/v1/cycles/members GET alias.
- [ ] `test/cycle-member-balances.test.js`: cover route, authorization, cycle selection, member inclusion, and errors.
- [ ] `test/cycle-member-balances.integration.test.js`: cover actual decimal aggregates, partial payments, zero activity, header identity fallback, and isolation across groups/cycles.
- [ ] `README.md`: document response fields, balance rules, aliases, and access policy.

Given a current eligible cycle, when an authorized financial reader requests members, then the response follows the agreed membership scope and returns exact balances for that cycle.

Given ledger activity in another group or cycle, when balances are calculated, then that activity does not affect the response.

## Implementation Notes

- Proposed access: OWNER, ADMIN, TREASURER, AUDITOR, consistent with financial report permissions.
- Resolve effective member and cycle from entry identity with transaction-header fallback for older and loan-disbursement entries.
- Aggregate transaction entry amounts by the agreed entry types; do not join account postings, which would duplicate amounts.
- Use SQL numeric sums and serialize monetary amounts as decimal strings; do not sum using JavaScript floating-point numbers.
- Existing restricted reader role has no ledger grants. Use explicitly group-scoped queries under the backend connection in a consistent transaction snapshot; no migration or deployment is planned.
- Working tree was clean at investigation start. No implementation edits made while awaiting semantics.

## Verification

- `node --test test/cycle-member-balances.test.js`: endpoint behavior.
- Run PostgreSQL integration coverage when a disposable TEST_DATABASE_URL is available; clearly report if unavailable.
- `npm test` and `git diff --check`.
