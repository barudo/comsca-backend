---
title: 'Record Group Donation Endpoint'
type: 'feature'
created: '2026-10-03'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '0dfecb81fea76da3fe32423051a20651315efdcc'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The backend has no endpoint for recording a donation received by the selected COMSCA group, so the donation cannot be captured as a balanced, auditable financial event.

**Approach:** Add `POST /api/v1/transactions/donations` to write one `DONATION` transaction header, one transaction entry, and two signed account postings atomically. The request uses `debit` and `credit` for account IDs. Debit a selected current-cycle ASSET account and credit the selected `INCOME` account reserved as `4300` Donation Income. Accept an amount, required date, and either `description` or `remarks`; when both aliases are supplied they must match. Interpret the date as an Asia/Manila calendar date and store its local midnight as transaction `occurred_at`. Scope the operation to the authenticated group and its current cycle. Permit active and distributing cycles only; reject draft, closed, and no-current-cycle writes.

## Boundaries & Constraints

**Always:** Allow only OWNER, ADMIN, or TREASURER of the selected group. Require both accounts to belong to that group and exactly the active/distributing current cycle; debit must be ASSET, credit must be INCOME code `4300`. Accept account IDs in `debit` and `credit`. Amount must be positive with at most two decimal places and fit `numeric(18,2)`. Keep the transaction header amount, component amount, debit posting, and absolute credit posting equal. Return the transaction, component entry, and both account postings only after commit. Use explicit group predicates and preserve decimal values as strings.

**Never:** Create a separate donation table, post to another income account, permit closed-cycle writes, or persist calculated totals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid donation | Current writable cycle, valid accounts and amount/date | HTTP 201 with transaction and two opposite-signed postings for the same amount | N/A |
| Description alias | Either `description` or `remarks`; if both, identical values | Store the resolved text on transaction and component | Conflicting aliases return HTTP 400 |
| Invalid amount/date/IDs | Malformed or unsupported values | No rows created | HTTP 400 |
| Account scope/type | Foreign, wrong-cycle, non-ASSET debit, or non-4300/non-INCOME credit | No rows created | HTTP 400/404 |
| Cycle unavailable | No active/distributing cycle, or only a draft/closed cycle | No rows created | HTTP 409 |
| Persistence error | Header, component, or posting write fails | Transaction fully rolls back | HTTP 409 for ledger conflicts |

</frozen-after-approval>

## Code Map

- `src/handlers/payment-transactions.js` -- reuse positive exact-decimal parsing, financial writer authorization, cycle-scoped accounts, atomic transaction/component/posting writes, response shape, and database error mapping.
- `src/handlers/contributions.js` and `src/handlers/penalties.js` -- reuse the locked current-cycle selection and permitted cycle statuses, narrowed to active/distributing for the seeded donation account chart.
- `migrations/028_add_member_assistance_expense_account.js` / `migrations/019_seed_cycle_accounts.js` -- the current chart reserves `4300` Donation Income as INCOME.
- `src/routes/index.js` -- register the authenticated POST endpoint behind existing group resolution.
- `test/payment-transactions.test.js` and `test/dashboard.integration.test.js` -- route-test and real-ledger fixture patterns.

## Tasks & Acceptance

**Execution:**
- [x] `src/handlers/donations.js` -- validate payload, authorize writer, lock current writable cycle, validate cycle accounts, and atomically record transaction/header/component/postings.
- [x] `src/routes/index.js` -- register `POST /api/v1/transactions/donations` with existing authentication middleware.
- [x] `README.md` -- document request, date behavior, response, authorization, and errors.

The user requested implementation only and explicitly asked not to run tests; do not execute test commands.

**Acceptance Criteria:**
- Given valid cycle accounts and a donation request, when POST succeeds, then the returned transaction is type DONATION and the transaction component and both postings carry the same amount with debit positive and credit negative.
- Given accounts from another group/cycle or incorrect account types/codes, when POST is called, then it creates no rows.
- Given the actor is unauthenticated or lacks a writer role, when POST is called, then the request is denied before financial writes.
- Given any journal write fails, when the request ends, then no donation rows remain committed.

## Implementation Notes

- User confirmed `POST /api/v1/transactions/donations`, request account fields `debit` and `credit`, and active/distributing cycle eligibility.
- Do not run tests, per the user's instruction.

## Review Triage Log

- `resolved` -- User selected active/distributing cycles only, where Donation Income (4300) is seeded; drafts and closed cycles are rejected.
- `false` -- Recorder attribution was not requested; existing group-level contribution/interest transactions also store `user_id: null`, and storing a member identity would be invalid for non-enrolled writers.
- `false` -- No idempotency key or duplicate-request contract was specified; identical amount/date/description can represent distinct donations, and existing transaction endpoints create one transaction per POST.
- `resolved` -- The PostgreSQL success case now asserts both requested account IDs and opposite-signed amounts in the returned postings.
- `resolved` -- README now includes a complete response example, optional-description behavior, and endpoint error mappings.
- `false` -- The route fixture and PostgreSQL integration assertion cover active/distributing cycle posting; neither was run, per user instruction.

## Design Notes

## Verification

**Verification:** Tests were not run, per user instruction. `node --check` passed for the handler, route registry, route-test file, and PostgreSQL integration fixture; `git diff --check` passed. The automated review launcher returned source excerpts instead of reviewer findings, so independent review verdicts remain incomplete.
