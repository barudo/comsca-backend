---
title: 'Seed Member Assistance Expense Account'
type: 'feature'
created: '2026-10-02'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'b110e5285e2d7ea7e74e8df6f9d296322ebe60db'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Newly activated cycle charts do not include an expense account for member assistance.

**Approach:** Add `5100` Member Assistance Expense (`EXPENSE`) to the cycle account seed template so newly activated `active` or `distributing` cycles receive it. Preserve existing account rows and postings; do not backfill charts for cycles that were already active when the migration is applied.

## Boundaries & Constraints

**Always:** Follow existing cycle-account idempotency and reserved-definition validation. Keep the account cycle-scoped to the selected group. Migration rollback restores the prior seed template without deleting seeded accounts or postings.

**Never:** Add a group-level cycle-less account, change existing account definitions, or alter financial transaction behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Activate new cycle | Draft transitions to `active` or `distributing` | Seed account `5100`, named Member Assistance Expense, type EXPENSE exactly once | N/A |
| Seed retry | Existing compatible `5100` row | Preserve its ID and timestamps; seed remaining defaults idempotently | N/A |
| Reserved-code conflict | Existing `5100` has a different name or type | Activation fails atomically and cycle remains draft | Database constraint error |
| Rollback | Migration is reverted | Future activations use prior template; existing accounts/postings remain unchanged | N/A |

</frozen-after-approval>

## Code Map

- `migrations/026_add_contribution_cycle_accounts.js` -- current template-replacement pattern and rollback behavior; it updates future seeding without backfilling existing rows.
- `migrations/025_remove_interest_receivable_from_cycle_defaults.js` -- prior complete cycle chart and rollback template.
- `migrations/019_seed_cycle_accounts.js` -- activation trigger, idempotent inserts, and reserved-account compatibility validation.
- `test/account-ledger-migration.integration.test.js` -- disposable-PostgreSQL coverage for new activations, retries, incompatible definitions, rollback, and preserved postings.
- `README.md` -- documents the default cycle chart; add the new account there.

## Tasks & Acceptance

**Execution:**
- [x] `migrations/028_add_member_assistance_expense_account.js` -- update the seeding function to add reserved account `5100` and restore the prior template on rollback.
- [x] `test/account-ledger-migration.integration.test.js` -- verify activation for both supported statuses, idempotency, conflict rejection, rollback, and preservation of existing accounts/postings.
- [x] `README.md` -- include Member Assistance Expense in the documented default chart.

**Acceptance Criteria:**
- Given a newly activated cycle, when default accounts are seeded, then exactly one account with code `5100`, name `Member Assistance Expense`, and type `EXPENSE` exists in that group and cycle.
- Given a cycle with a compatible preexisting `5100` account, when activated, then the account is retained and seeding succeeds.
- Given a cycle with an incompatible `5100` definition, when activated, then activation rolls back without partially seeding accounts.
- Given the migration is rolled back, when a new cycle activates, then the old default chart is used and existing account entries are unchanged.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `node --test test/account-ledger-migration.integration.test.js` -- skipped because `TEST_DATABASE_URL` is not configured.
- `npm test` -- 134 passed; four database-gated tests skipped.
