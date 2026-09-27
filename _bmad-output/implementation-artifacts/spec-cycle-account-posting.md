---
title: 'Cycle chart of accounts and separate accounting postings'
type: 'feature'
created: '2026-09-27'
status: 'in-review'
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

**Never:** Duplicate writable postings, edit applied migrations, deploy, migrate the configured remote database, or add API/frontend features. Automatic transaction-type posting rules remain outside scope.

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
- [x] `README.md` — document chart, activation, new tables, compatibility and posting examples.

**Acceptance Criteria:**
- Given draft activation, when it succeeds, then all basic typed accounts exist for that cycle and prior-cycle accounts remain unchanged.
- Given a member payment, when reading the member ledger, then its component breakdown is available without querying accounts.
- Given invalid amounts, group/cycle references or concurrent conflicting edits, when committing, then inconsistent postings cannot persist.
- Given legacy accounting rows, when migrating, then debit/credit values and descriptions survive and no unproven business split is invented.

## Implementation Notes

- Implemented migrations 018/019, signed postings, activation seeding, historical conversion and guarded rollback.
- Full suite passed on disposable PostgreSQL 18: 80 tests passed, zero failures/skips. Matrix scenarios covered by the accounting tests and migration integration test.
- Historical integration fixtures now cap their legacy migration phase at 013; remaining checks apply the full migration chain. Cycle-list expectations now match the existing current-cycle API.

## Spec Change Log

## Review Triage Log

## Design Notes

Use `transaction_entries` fields `id`, `group_id`, `transaction_id`, `type`, `amount`, description and timestamps. `account_entries` stores an ID, group, component FK, account FK, signed amount (positive debit, negative credit), description and timestamps. Derive transaction/member/cycle through the component header. Account entries have no independent member ownership.

Legacy conversion creates one aggregate business component per transaction using its header type/amount and attaches existing postings. Preflight rejects header/ledger mismatches rather than changing money. Retain old group accounts; clone referenced definitions into each known historical cycle and remap only corresponding postings. Do not guess a cycle for cycle-less history. Reject rollback if newer structures cannot be represented losslessly in the old schema; never silently drop history.

## Verification

- `npm test`: all unit/request tests pass; report database skips accurately.
- Execute integration and migration up/down coverage only on a verified disposable database with `TEST_DATABASE_URL`, never the application database.
- Verify concurrent entry changes, mutation of parent scope, seeding failure atomicity, existing active-cycle backfill and retained closed-cycle history.
