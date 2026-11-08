---
title: 'Cycle transaction freeze and unfreeze'
type: 'feature'
created: '2026-11-09'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 959998ddc61769f0165c7375d2afd25c729afb0c
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Prevent ordinary financial writes outside meetings through an independent cycle freeze flag, enabled for new and existing cycles. Authorized owners and administrators control it; members retain account and report access. Enforce inside financial posting transactions, including internal callers, with conflicting cycle row locks.

Decisions confirmed by the user:
- Existing group-scoped `OWNER` and `ADMIN` roles manage freeze only within their group.
- Block voiding legacy transactions without a cycle until a cycle is assigned.
- Include `transactions_frozen` on `GET /api/v1/cycles`.

## Boundaries & Constraints

**Always:** Preserve existing group isolation, RLS, double-entry accounting, document numbering, and draft -> active -> distributing -> closed lifecycle. Only active cycles can unfreeze or accept ordinary financial postings. Preserve authorized distribution declaration and payout processing under existing rules. Use TypeScript for new feature code, Knex migrations, existing authentication, and PostgreSQL transactions. Use actual bigint user references. Record transitions atomically; repeated requests leave timestamps and logs unchanged.

**Never:** Trust frontend roles; grant officers freeze management; expose audit mutations; modify existing financial records or balances in migration; deploy or migrate live databases during implementation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Manage | Authorized actor, scoped cycle | PATCH freeze/unfreeze returns success/data with cycleId, transactionsFrozen, relevant timestamp | Existing authentication and group checks |
| Status | Authenticated group member | GET freeze-status returns state, actor identity, timestamps, backend canManageFreeze | Outsiders denied |
| Inactive | Draft/distributing/closed unfreeze | No changes or audit | Lifecycle conflict |
| Frozen | Ordinary create/update/void/batch | No accounting changes | 423, TRANSACTIONS_FROZEN and requested message |
| Retry | Already desired state | Same metadata, no duplicate audit | Unfreeze still requires active |
| Race | Posting owns cycle lock first | Freeze waits for commit/rollback | Later postings reject after freeze |
| Read | Frozen cycle | Existing reports/accounts readable | Existing permissions |

</frozen-after-approval>

## Code Map

- `src/middleware/{authenticate,group-slug}.js`: Supabase identity and group header; verify database membership.
- `src/handlers/cycles.js`: actor/cycle locks, explicit column lists, lifecycle delegation.
- `migrations/{001_create_groups_users_cycles,008_add_user_group_roles}.js`: bigint IDs and group roles.
- `src/handlers/payment-transactions.js`: collections/receipts; reorder accounts after cycle locks.
- `src/handlers/group-account-transactions.js`: shared expense/donation posting.
- `src/handlers/{loan-disbursements,expense-payments,contributions,interests,penalties,transactions}.js`: remaining ordinary financial writes.
- `src/services/cycle-distributions.js`, `src/handlers/member-payouts.js`: preserve distribution exceptions.
- `src/app.js`: centralized error translation.
- `test/*.test.js`: node:test/Knex fixtures; integration tests use TEST_DATABASE_URL.
- `package.json`, `serverless.yml`: CommonJS on Lambda Node 20; add compilation for new TypeScript modules.

## Tasks & Acceptance

**Execution:**
- [ ] `migrations/042_cycle_transaction_freeze.js`: add five freeze columns with true default and bigint actor FKs; create cycle_freeze_logs with constrained actions, scoped read protection and no mutation API; extend only necessary reader grants. Preserve existing policies and rows.
- [ ] `src/services/cycle-freeze.ts`: implement assertCycleTransactionsUnfrozen(cycleId,trx,context), scoped actor authorization, locked state transitions and audit inserts. Require active state and explicit false; acquire cycle lock until caller transaction completes. Reject voids with no cycle.
- [ ] `src/handlers/cycle-freeze.ts`, `src/routes/index.js`: authenticated PATCH /api/v1/cycles/:cycleId/freeze and /unfreeze, GET /freeze-status. Validate IDs/reason; backend permission calculation; expose actor names from first_name/family_name.
- [ ] `src/handlers/cycles.js`, `src/app.js`: include `transactions_frozen` in `GET /api/v1/cycles`; translate frozen failures to requested structured error without changing unrelated errors.
- [ ] Financial handlers listed in Code Map: call shared assertion before any financial mutation within the same transaction; extract reusable posting boundaries where needed so internal calls cannot skip enforcement. Standardize actor -> cycle -> dependent-row locking. Preserve distribution exception without a client-controlled bypass flag.
- [ ] `package.json`, `package-lock.json`, `tsconfig.json`, `serverless.yml`, `.gitignore`: minimal TypeScript build integration compatible with existing CommonJS entrypoints; avoid converting unrelated code.
- [ ] `test/cycle-freeze.test.js`, `test/cycle-freeze.integration.test.js`, existing financial fixtures: cover the matrix and all 23 requested test categories, with real PostgreSQL concurrency, rollback, migration defaults, RLS and group isolation. Unfreeze existing successful-posting fixtures explicitly.
- [ ] `README.md`, `docs/transaction-freeze.md`: API contracts, protected-path inventory, distribution exceptions, build/migration/deployment sequence and rollback limits.

**Acceptance Criteria:**
- Given existing and newly created cycles, when migration/creation completes, then each is frozen without ledger changes.
- Given authorized membership, when management endpoints run, then only approved owner/admin identities transition state and each transition has exactly one audit row.
- Given frozen cycles, when any ordinary financial write runs through API or internal posting service, then it fails atomically; reports and member accounts retain access.
- Given concurrent posting and freeze, when freeze succeeds, then prior posting has committed or rolled back and subsequent posting cannot commit while frozen.
- Given distributing/closed cycles, when freeze APIs run, then no ordinary posting or lifecycle bypass becomes available and authorized distribution behavior remains intact.

- Given cycles visible to a group member, when GET /api/v1/cycles runs, then each returned cycle includes its stored `transactions_frozen` boolean.
- Given a legacy transaction with no cycle, when voiding is attempted, then it fails without financial mutations.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

- TypeScript build/typecheck and `npm test` must pass.
- Run isolated PostgreSQL integration tests with TEST_DATABASE_URL; report unavailable infrastructure and skipped tests explicitly.
- Audit every transaction_entries/account_entries and financial-header write against coverage inventory; document exceptions and any remaining gaps.
