---
title: 'Add contribution accounts to cycle activation'
type: 'feature'
created: '2026-09-28'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

User confirmed monthly contributions are non-refundable group income and wants the activation chart to support recording unpaid amounts. Add migration 026 to seed Contributions Receivable (1400, ASSET) and Contribution Income (4400, INCOME) alongside the ten defaults from migration 025. Keep Interest Receivable omitted. Preserve existing accounts and postings, group/cycle scope, idempotence, and reserved-code compatibility checks. Update future seeding only; do not backfill old cycles. Rollback restores the ten-account template without deleting contributed accounts or history. Document the accounts and verify migration up/down and activation on disposable PostgreSQL. No live migration, accrual calculation, or contribution posting endpoint is included.

</frozen-after-approval>

## Implementation Notes

- Migration 025 owns the current ten-account template; new migration 026 replaces only seed_cycle_accounts, preserving its trigger and old migrations.
- New codes 1400 and 4400 do not collide with existing default codes.

- Implemented migration 026 and README; updated latest account-list expectations to12 defaults. Tests exercise exact chart definitions, compatibility conflicts, idempotence, existing-cycle upgrades, preserved account IDs/postings, and down restoring10 defaults.
- Initial integration run stalled due to a nested test scheduled on the outer test context. Corrected to the immediate parent context. Final run on fresh PostgreSQL18:116 passed, zero skips/failures. git diff --check passed. No production migration applied.

## Review Triage Log

- Low: existing ten-account cycle upgrade untested. Added distributing transition and exact twelve-account assertion.
- Low: compatible pre-existing contribution IDs untested. Added partially seeded draft activation and exact row preservation assertions.
- Low: reseeding after rollback untested. Added function call on a cycle containing posted contributions and exact row preservation assertions.
- Low, rejected: duplicate account definition checks through list API. API already compares its full response to persisted accounts; migration tests independently verify exact new code/name/type tuples. No demonstrated gap requiring duplicated assertions.
