---
title: 'Cycle chart of accounts and separate accounting postings'
type: 'feature'
created: '2026-09-27'
status: 'done'
baseline_commit: '06b125d8e753d3c50697559bd1785abec38aed1f'
route: 'dispatch'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Member transaction components and accounting postings currently share one table. Accounts have no cycle ownership, and activating a cycle does not create its basic chart of accounts.

**Approach:** Keep `transactions` as business headers and convert `transaction_entries` to business components with a type and amount. Introduce a physical `account_entries` table for signed postings (positive debit, negative credit) linked to a business component and an account. Create separate typed accounts for each cycle on activation, retaining previous cycles' accounts. The member ledger uses only transactions and their business components.

## Boundaries & Constraints

**Always:** Preserve optional transaction member/cycle fields and existing group/membership foreign keys. A supplied cycle need only exist, not be current. Preserve exact decimal money and historical postings. Account types remain `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE`. Cycle accounts have unique codes within their group/cycle. Retain nullable-cycle group accounts for cycle-less operations and legacy records; a cycle-specific account can only receive postings from its own cycle. Group accounts may receive group or cycle activity. Never change an account's group/cycle once created.

A payment of 1100 can contain loan principal 1000 and penalty 100 as two business components. Each component has balanced accounting postings whose debit and credit totals each equal its amount; component amounts sum to the header amount. For a loan disbursement of 1000, debit Loans Receivable 1000 and credit the selected funding asset 1000. Save headers, components and postings atomically, with deferred checks and serialization of competing writes.

On activation, create this proposed basic chart with zero opening balances:

| Code | Account | Type |
|---|---|---|
| 1000 | Cash | ASSET |
| 1100 | Loans Receivable | ASSET |
| 1200 | Interest Receivable | ASSET |
| 1300 | Penalties Receivable | ASSET |
| 2000 | Accounts Payable | LIABILITY |
| 3000 | Equity | EQUITY |
| 4000 | Interest Income | INCOME |
| 4100 | Penalty Income | INCOME |
| 4200 | Other Income | INCOME |
| 4300 | Donation Income | INCOME |
| 5000 | Operating Expenses | EXPENSE |

Seed atomically and without duplicates or balance carryover. Reject incompatible reserved-code definitions instead of overwriting custom data. Backfill active/distributing cycles only; retain closed history.

**Never:** Duplicate writable postings, edit applied migrations, deploy, migrate the configured remote database, or add frontend or posting API features. The user subsequently authorized the read-only cycle accounts endpoint below. Automatic transaction-type posting rules remain outside scope.

## Authorized Account Listing Extension

The user requested `GET /api/v1/cycles/accounts` during implementation. Return definitions for the selected group's current (draft/active/distributing) cycle, excluding closed-cycle and cycle-less accounts. Resolve the group from `x-group-slug` and authenticate a bearer token. Allow OWNER, ADMIN, TREASURER and AUDITOR roles within that group; deny MEMBER and cross-group access. Return `{success:true,current_cycle_id,accounts}` ordered by code/ID, or null cycle and an empty list if no current cycle exists. Drafts return whatever accounts exist, normally none until activation. Query parameters cannot override group/cycle selection. Use restricted-reader RLS and no-store responses.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|---|---|---|---|
| Activation | Draft becomes active | Basic cycle accounts created atomically | Seeding failure rolls back activation |
| Repeated activation | Same cycle already active | No duplicate accounts or resets | Unique scope enforced |
| New cycle | Earlier cycle closed | Separate account IDs; earlier accounts retained | No balance carryover |
| Split payment | Components 1000 and 100 | Header 1100; each component independently balanced | Reject mismatched totals |
| Wrong scope | Account in another group/cycle | No posting committed | Reject including parent updates |
| Group expense | No member/cycle | Group-account postings accepted | Preserve optionality |
| Legacy history | Existing debit/credit rows | Preserve amounts, accounts and descriptions | Abort ambiguous/inconsistent conversion |

</frozen-after-approval>

## Code Map

- `migrations/005_create_transactions.js`: preserve optional header cycle/member and group foreign keys.
- `migrations/006_create_accounts_and_transaction_entries.js`: replace entry-specific balance triggers; reuse parent-touch serialization.
- `src/handlers/cycles.js`: status update already locks cycle and actor; database seeding needs no API change.
- `test/login.integration.test.js`: existing disposable PostgreSQL accounting tests need adaptation.

## Tasks & Acceptance

**Execution:**
- [x] `migrations/018_scope_account_ledger.js` — add account cycle scope, scoped uniqueness, business components and account postings; migrate history; enforce totals, scope, RLS and safe rollback.
- [x] `migrations/019_seed_cycle_accounts.js` — add activation trigger and active/distributing backfill; rollback removes machinery without deleting history.
- [x] `test/login.integration.test.js` — cover totals, scope, optionality, activation, repeats and failures.
- [x] `test/account-ledger-migration.integration.test.js` — verify legacy conversion, preflight failures and rollback safety on a disposable database.
- [x] `src/handlers/cycle-accounts.js`, `src/routes/index.js`, `migrations/020_allow_cycle_accounts_read.js`, `test/cycle-accounts.test.js` — current-cycle account read endpoint and isolation.
- [x] `migrations/021_validate_account_entries_after_changes.js` — enforce ledger validation after child mutation under immediate constraints.
- [x] `README.md` — document chart, activation, new tables, compatibility and posting examples.

**Acceptance Criteria:**
- Given draft activation, when it succeeds, then all basic typed accounts exist for that cycle and prior-cycle accounts remain unchanged.
- Given a member payment, when reading the member ledger, then its component breakdown is available without querying accounts.
- Given invalid amounts, group/cycle references or concurrent conflicting edits, when committing, then inconsistent postings cannot persist.
- Given legacy accounting rows, when migrating, then debit/credit values and descriptions survive and no unproven business split is invented.

## Implementation Notes

- User committed the initial migrations as f7bd6bb during work. Preserve those migration files; validation correction is additive migration 021.
- Added `src/handlers/cycle-accounts.js`, route registration, migration 020 account-read grants/policy, request tests and real PostgreSQL endpoint tests.
- Review found an immediate-constraint defect in BEFORE child triggers. Migration 021 uses AFTER triggers; regression verifies immediate deletion is rejected.
- Final full suite with migrations through 021 on a fresh disposable PostgreSQL 18 instance: 84/84 passed, zero failures/skips. Additional tests cover exact maximum decimal amounts and account mappings across historical cycles. Temporary containers were removed.
- Automated verification-gap reviewer could not run due to its usage limit. Remaining review was completed locally; blind and edge-case reviewers returned results.

- Implemented migrations 018/019, signed postings, activation seeding, historical conversion and guarded rollback.
- Full suite passed on disposable PostgreSQL 18: 80 tests passed, zero failures/skips. Matrix scenarios covered by the accounting tests and migration integration test.
- Historical integration fixtures now cap their legacy migration phase at 013; remaining checks apply the full migration chain. Cycle-list expectations now match the existing current-cycle API.

## Spec Change Log

## Review Triage Log

| Finding | Verdict and evidence | Resolution |
|---|---|---|
| BEFORE trigger validates stale child state under IMMEDIATE constraints | High: the header check runs before DELETE, allowing an unbalanced committed ledger. | Patched with AFTER triggers in additive 021 and failing-delete regression. |
| Repeated validation can be quadratic for large transactions | Low: repeated trigger queues rescan components; ordinary payment sizes are small and no bulk import is requested. | No queue-consolidation complexity added. |
| Concurrency test is not two balanced rewrites or concurrent cycle reassignment | Low: existing test proves parent locking and rejected invalid commit; parent-scope rejection has separate coverage. | Additional interleavings not required for this bounded change. |
| Component-data rollback guard untested | Medium: cycle guard previously masked that branch. | Added cycle-less metadata rejection and unchanged-row assertions. |
| Legacy account remapping not directly checked | Medium: previous assertions omitted account identity. | Added exact code/name/type/description mapping for every posting, including one source used by multiple cycles. |
| Posting numeric constraints lack boundaries | Medium: new signed posting shape needs independent checks. | Added zero/NaN posting and nonpositive component rejection; populated roundtrip uses maximum exact decimal amount. |
| README implies all backfilled balances start at zero | Low: historical postings survive for existing accounts. | Clarified only newly created accounts start empty. |
| Database test cleanup registered too late | Low: setup failure could leave the admin pool open. | Registered cleanup before CREATE DATABASE and track creation. |

Edge-case reviewer returned no findings. Verification-gap reviewer failed from a usage limit; local audit covered endpoint authorization, RLS, current-cycle selection, migration mapping and constraints.

## Design Notes

Use `transaction_entries` fields `id`, `group_id`, `transaction_id`, `type`, `amount`, description and timestamps. `account_entries` stores an ID, group, component FK, account FK, signed amount (positive debit, negative credit), description and timestamps. Derive transaction/member/cycle through the component header. Account entries have no independent member ownership.

Legacy conversion creates one aggregate business component per transaction using its header type/amount and attaches existing postings. Preflight rejects header/ledger mismatches rather than changing money. Retain old group accounts; clone referenced definitions into each known historical cycle and remap only corresponding postings. Do not guess a cycle for cycle-less history. Reject rollback if newer structures cannot be represented losslessly in the old schema; never silently drop history.

## Verification

- `npm test`: all unit/request tests pass; report database skips accurately.
- Execute integration and migration up/down coverage only on a verified disposable database with `TEST_DATABASE_URL`, never the application database.
- Verify concurrent entry changes, mutation of parent scope, seeding failure atomicity, existing active-cycle backfill and retained closed-cycle history.
