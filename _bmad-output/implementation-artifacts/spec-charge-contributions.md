---
title: 'Charge contributions to all current-cycle members'
type: 'feature'
created: '2026-09-29'
status: 'done'
baseline_commit: 'f76acde95eeab3fc784f9831033e945425876a8f'
route: 'dispatch'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add POST /api/v1/contributions/charge. Create one CONTRIBUTION transaction for the selected group's current cycle, with one CONTRIBUTION transaction entry for every enrolled member. Each member entry uses the amount supplied in the request. Record the total contributions in account_entries using the request's debit and credit account selections.

User approved one debit/credit pair per member. Their account totals equal the full charge, preserving the existing per-entry balance rules.

## Boundaries & Constraints

Always resolve the group through x-group-slug and authenticate the caller. Follow existing financial-write authorization: OWNER, ADMIN, TREASURER. Resolve the current cycle using the existing newest non-closed cycle query. Persist the transaction, member entries, and balanced postings atomically. Preserve group isolation, cycle membership, exact decimal arithmetic, and all existing ledger constraints unless the approved posting design requires a scoped extension.

Use a new migration for member identity on transaction_entries; existing entries remain valid. Do not apply migrations to a live database or deploy as part of implementation. No recurring scheduling or contribution payment endpoint is included.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Charge | Body has amount, debit, credit, optional description; current cycle has members | 201 with success, transaction, entries, account_entries; header amount equals member count times amount | Atomic commit |
| Authorization | Authenticated group user lacks financial-write role | No writes | 403 |
| Invalid body | Invalid account ID, same debit/credit, unknown fields, nonpositive amount, excess decimal places | No writes | 400 |
| Overflow | Per-member amount or aggregate exceeds numeric(18,2) | No writes | 400 |
| Missing cycle or members | No current cycle or zero enrolled members | No zero-value transaction | 409 |
| Missing account | Selected account does not exist in selected group | No writes | 404 |
| Invalid scope | Selected cycle account belongs to another cycle | No writes | 400 |
| Concurrent conflict | Membership/lifecycle/posting conflict | Roll back all writes | 409 |

</frozen-after-approval>

## Code Map

- src/routes/index.js: register authenticated group-scoped endpoint and bind handler instance.
- src/handlers/loan-disbursements.js: financial-role authorization, strict body/ID/decimal validation, transactional posting, response envelope and error mapping.
- src/handlers/cycle-members.js: current-cycle selection ordered by created_at/id, cycle row locking used to serialize enrollment and lifecycle changes.
- migrations/005_create_transactions.js: nullable transaction user_id permits group-wide header; composite group references and cycle membership constraints provide integrity pattern.
- migrations/018_scope_account_ledger.js: transaction_entries lacks member identity; account_entries attaches to a component; deferred checks require each component's positive and negative posting totals to equal component amount.
- migrations/021_validate_account_entries_after_changes.js: after-change validation trigger timing must be preserved.
- migrations/026_add_contribution_cycle_accounts.js: contribution receivable 1400 ASSET and contribution income 4400 INCOME are seeded on cycle activation.
- test/loan-disbursements.test.js: injected Knex runner and serverless HTTP tests.
- test/account-ledger-migration.integration.test.js: disposable PostgreSQL migration and constraint test patterns.

## Tasks & Acceptance

**Execution:**
- [x] migrations/027_add_contribution_member_entries.js -- add optional member identity with same-group and parent-cycle membership integrity; retain compatibility for old entries and provide rollback safeguards for member data.
- [x] src/handlers/contributions.js -- validate request, authorize actor, lock current cycle and enrolled members, validate selected accounts, compute exact total, and persist charge atomically using the resolved posting design.
- [x] src/routes/index.js -- register POST /api/v1/contributions/charge with authenticate.
- [x] test/contributions.test.js -- cover HTTP success, role restrictions, validation, group and cycle isolation, empty cycles, overflow, and rollback.
- [x] test/account-ledger-migration.integration.test.js -- verify member identity constraints, contribution posting balance, existing payment compatibility, and migration rollback using disposable PostgreSQL.
- [x] README.md -- document body, required headers, authorized roles, per-member amount, response and account posting behavior.

**Acceptance Criteria:**
- Given three enrolled members and amount 25.50, when an authorized actor charges contributions, then one CONTRIBUTION header records 76.50 and three member-identified CONTRIBUTION entries each record 25.50.
- Given members in another cycle or group, when charging the selected current cycle, then those members receive no charge.
- Given a failure during posting or deferred validation, when the request completes, then no partial header, member entries, or postings remain.
- Given an existing payment or loan disbursement, when the migration is applied and those endpoints run, then their prior behavior and ledger validation remain valid.

## Implementation Notes

Investigation is complete enough to identify the ledger decision above. No implementation or migration has been applied. Proposed account validation follows the established contribution chart: debit Contributions Receivable (1400 ASSET), credit Contribution Income (4400 INCOME). Body account selections remain explicit. Repeated successful requests create separate charges, consistent with existing posting endpoints.

Implemented migration 027, handler/route, tests and README. Verified full suite on disposable PostgreSQL 18: 123 passed, no failures or skips. Matrix rows are covered by the six contribution request tests; database integration verifies member constraints, balanced postings, legacy component compatibility and guarded rollback. git diff --check passed.

Review patches added real PostgreSQL endpoint persistence, statement/commit failure rollback, enrollment and closure races, and 1,001-member batching coverage. Final full suite on a fresh PostgreSQL 18 cluster: 125 passed, zero failures/skips; git diff --check passed. All patch findings resolved. Existing large-roster ledger validation cost is recorded in deferred-work.md. No live migration or deployment performed.

## Spec Change Log

## Review Triage Log

- Blind hunter, medium, defer: existing migrations 018/021 schedule repeated full-header balance validation after child changes. A real 1,001-member endpoint charge succeeded with 1,001 entries, 2,002 postings and exact total 10.01 in 7.397 seconds locally. Quadratic validator work is pre-existing; broader ledger optimization is deferred, with production runtime for larger rosters unverified.
- Blind hunter, medium, patch: mock rollback truncates its own write array and cannot prove actual endpoint transaction boundaries. Add real PostgreSQL request success and induced statement/commit failure coverage.
- Blind hunter, low, patch: SQL lock assertions do not exercise enrollment/closure interleavings. Add deterministic request concurrency cases using the existing waitForLocks helper.
- Blind hunter, medium, patch: three-member fixtures do not exercise batching, and fake IDs overlap in later batches. Add 1,001-member completeness, association and later-batch failure cases with unique generated IDs.
- Blind hunter, low, patch: README omits the older-cycle account provisioning prerequisite. Document the existing seed_cycle_accounts function and compatibility behavior.
- Blind hunter, false, reject: the earlier implementation note records planning-time state and is followed by an appended implementation result, consistent with the append-only workflow. The proposed correction only edits the build spec and is rejected by review rules.
- Verification reviewer, medium, patch: request tests pass the root database as trx, so an escaped write would go undetected. Same root cause as the real-database endpoint test gap above; fix with actual PostgreSQL request rollback assertions.
- Verification reviewer, medium, patch: no request test crosses the 1,000-member boundary. Same root cause as batching gap above; cover 1,001 distinct members and their postings.

## Verification

- node --test test/contributions.test.js -- all request cases pass.
- TEST_DATABASE_URL pointing to a dedicated disposable PostgreSQL instance, npm test -- full suite passes including ledger/migration integration tests.
- git diff --check -- no whitespace errors.
