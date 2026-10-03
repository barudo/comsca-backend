---
title: 'Record Group Donation Endpoint'
type: 'feature'
created: '2026-10-03'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '0dfecb81fea76da3fe32423051a20651315efdcc'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The backend has no endpoint for recording a donation received by the selected COMSCA group, so the donation cannot be captured as a balanced, auditable financial event.

**Approach:** Add `POST /api/v1/donations` to write one `DONATION` transaction header, one transaction entry, and two signed account postings atomically. Debit a selected current-cycle ASSET account and credit the selected `INCOME` account reserved as `4300` Donation Income. Accept an amount, required date, and either `description` or `remarks`; when both aliases are supplied they must match. Interpret the date as an Asia/Manila calendar date and store its local midnight as transaction `occurred_at`. Scope the operation to the authenticated group and its current cycle. Permit the existing transaction-writer cycle states (`draft`, `active`, `distributing`), and reject closed/no-current-cycle writes.

## Boundaries & Constraints

**Always:** Allow only OWNER, ADMIN, or TREASURER of the selected group. Require both accounts to belong to that group and exactly the current cycle; debit must be ASSET, credit must be INCOME code `4300`. Amount must be positive with at most two decimal places and fit `numeric(18,2)`. Keep the transaction header amount, component amount, debit posting, and absolute credit posting equal. Return the transaction, component entry, and both account postings only after commit. Use explicit group predicates and preserve decimal values as strings.

**Never:** Create a separate donation table, post to another income account, permit closed-cycle writes, or persist calculated totals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid donation | Current writable cycle, valid accounts and amount/date | HTTP 201 with transaction and two opposite-signed postings for the same amount | N/A |
| Description alias | Either `description` or `remarks`; if both, identical values | Store the resolved text on transaction and component | Conflicting aliases return HTTP 400 |
| Invalid amount/date/IDs | Malformed or unsupported values | No rows created | HTTP 400 |
| Account scope/type | Foreign, wrong-cycle, non-ASSET debit, or non-4300/non-INCOME credit | No rows created | HTTP 400/404 |
| Cycle unavailable | No current cycle or closed cycle | No rows created | HTTP 409 |
| Persistence error | Header, component, or posting write fails | Transaction fully rolls back | HTTP 409 for ledger conflicts |

</frozen-after-approval>

## Code Map

- `src/handlers/payment-transactions.js` -- reuse positive exact-decimal parsing, financial writer authorization, cycle-scoped accounts, atomic transaction/component/posting writes, response shape, and database error mapping.
- `src/handlers/contributions.js` and `src/handlers/penalties.js` -- reuse the locked current-cycle selection and permitted cycle statuses.
- `migrations/028_add_member_assistance_expense_account.js` / `migrations/019_seed_cycle_accounts.js` -- the current chart reserves `4300` Donation Income as INCOME.
- `src/routes/index.js` -- register the authenticated POST endpoint behind existing group resolution.
- `test/payment-transactions.test.js` and `test/dashboard.integration.test.js` -- route-test and real-ledger fixture patterns.

## Tasks & Acceptance

**Execution:**
- [ ] `src/handlers/donations.js` -- validate payload, authorize writer, lock current writable cycle, validate cycle accounts, and atomically record transaction/header/component/postings.
- [ ] `src/routes/index.js` -- register `POST /api/v1/donations` with existing authentication middleware.
- [ ] `test/donations.test.js` and `test/dashboard.integration.test.js` -- cover success, access/scope validation, rollback, date storage, and balanced postings.
- [ ] `README.md` -- document request, date behavior, response, authorization, and errors.

**Acceptance Criteria:**
- Given valid cycle accounts and a donation request, when POST succeeds, then the returned transaction is type DONATION and the transaction component and both postings carry the same amount with debit positive and credit negative.
- Given accounts from another group/cycle or incorrect account types/codes, when POST is called, then it creates no rows.
- Given the actor is unauthenticated or lacks a writer role, when POST is called, then the request is denied before financial writes.
- Given any journal write fails, when the request ends, then no donation rows remain committed.

## Implementation Notes

- Added `POST /api/v1/donations` with the required `debit_account_id` and `credit_account_id` request fields, a locked writable-cycle selection, current-cycle account validation, and atomic DONATION header/component/posting writes.
- Stored date-only input as Asia/Manila midnight in `transactions.occurred_at`; description and remarks are accepted as matching aliases.
- Added route unit coverage, a PostgreSQL ledger fixture assertion, and README documentation.
- Focused unit tests pass (6 tests); the full suite passes 140 tests with 4 database-gated skips. `TEST_DATABASE_URL` is unavailable, so live PostgreSQL verification remains unrun.
- Review found the draft-state assumption cannot use the seeded chart: accounts are seeded only when cycles become active/distributing, and the public API has no draft cycle-account creation route. The implementation is removed pending a cycle-eligibility decision.

## Open Questions

1. Should donations be restricted to active/distributing cycles (where the seeded chart exists), should draft donations be allowed only when both accounts have been separately provisioned, or should cycle-account seeding be changed to include drafts? Restricting donations to active/distributing preserves the existing chart lifecycle; draft support otherwise requires manually provisioned accounts or a broader seeding change.

## Review Triage Log

- `medium` -- The approved spec and handler included drafts, but default cycle accounts (including Donation Income 4300) are seeded only on active/distributing transitions, and there is no public route to create accounts on drafts. This makes a normal draft donation impossible and needs a user decision on eligibility or seeding.
- `false` -- Recorder attribution was not requested; existing group-level contribution/interest transactions also store `user_id: null`, and storing a member identity would be invalid for non-enrolled writers.
- `false` -- No idempotency key or duplicate-request contract was specified; identical amount/date/description can represent distinct donations, and existing transaction endpoints create one transaction per POST.
- `low` -- The PostgreSQL success case did not assert both requested account IDs in the actual returned postings; this will be added when code is re-derived after the cycle decision.
- `low` -- README lacked a complete response example, explicit optional-description behavior, and specific error mappings; these docs fixes await the clarified cycle contract.
- `false` -- The unit fixture now asserts exact writable-cycle query bindings (`draft`, `active`, `distributing`), so removing those status filters fails the always-run test. PostgreSQL integration remains environment-gated.

## Design Notes

## Verification

**Commands:**
- `node --test test/donations.test.js test/dashboard.integration.test.js` -- focused tests pass; PostgreSQL coverage runs when `TEST_DATABASE_URL` is configured.
- `npm test` -- full backend suite passes.
