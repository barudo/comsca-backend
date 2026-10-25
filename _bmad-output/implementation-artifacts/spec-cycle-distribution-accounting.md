---
title: 'Declare cycle distributions with balanced accounting'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_commit: 'fc56795849bc4d8e80e6c34a6ea806824ecfa7c1'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval>
## Intent

Implement atomic distribution declaration through the existing PUT/PATCH cycle endpoint when active becomes distributing, and GET /api/v1/cycles/:cycleId/distributions. Persist member entitlements and balanced closing, capital, earnings postings. The original task plus the confirmed decisions below define requirements; confirmed decisions supersede deduction requests.

## Boundaries & Constraints

Use authenticated group scope, OWNER/ADMIN transition authorization, PostgreSQL transactions, cycle locking, journal voucher counters and exact decimal strings. Calculate from actual scoped ledger postings and eligible cycle membership, never dashboard caches. Exclude voided headers together with their reversals. Refund explicitly identified member equity, not Contribution Income. Allocate all positive or negative earnings proportionally using integer cents and deterministic largest-remainder allocation ordered by member ID. Reject zero total capital and unsupported, unattributed, negative or inconsistent member balances rather than inventing data. Reject losses exceeding total refundable capital because no member-loss receivable policy exists. Never create negative payables.

Close each income/expense account into earnings equity before allocation. Reverse debit/credit direction for losses while retaining positive component amounts. Transfer capital from its actual equity accounts into member payables. Reject declaration with 409 if any member has outstanding contributions, penalties or other unsupported collectibles; validate per member/account, never net one member against another. Outstanding loans are allowed: deduct up to each member’s positive gross entitlement with Dr Distribution Payable / Cr Loans Receivable, preserve any residual loan and never create negative payables. Loan deduction records reflect actual offsets; other deduction fields remain zero. Negative or unattributed receivables also require reconciliation before declaration. No cash movement, payouts, automatic completion, historical mutation, frontend changes, dependencies or production migration execution.

Persist one distribution per cycle/member with all requested amounts, pending status, paid amount zero and accounting references. Return exact summaries and insufficient-cash warnings. Repeated distributing requests return stored results without recalculation; legacy distributing cycles without records must return an explicit conflict. Group isolation and existing RLS remain intact.

## I/O & Edge-Case Matrix

| Scenario | Expected behavior |
|---|---|
| Active cycle with valid ledger | Atomic records, balanced journals, distributing status and summary |
| Positive/negative earnings | Exact proportional allocation; deterministic cents reconciliation |
| Outstanding contributions or penalties | 409; retain active status and original balances |
| Outstanding loans | Offset up to member entitlement; preserve residual debt |
| Invalid membership, capital or accounting | Validation error; no writes |
| Repeat/concurrent request | One declaration; existing records returned |
| Unauthorized/cross-group request | 403/404 without disclosure |
| Insufficient cash | Warning only; no cash posting |
| Any posting/commit failure | Full rollback including counters and status |

Confirmed on 2026-10-25: outstanding contributions and penalties block distribution; latest user revision permits unpaid loans deducted from proceeds; business mutations must be blocked while distributing. Keep read-only reports/retrieval, authentication/profile administration and explicit distributing-to-closed lifecycle action available. Enforce locks within write transactions, including voids and membership/loan-application mutations. Block modifying declared-cycle counters. No dispute workflow in this release: unresolved or unsupported balances require manual reconciliation before declaration. Do not silently assume missing ledger identities are eligible members.

</frozen-after-approval>

## Code Map

- `src/handlers/cycles.js`: cycleInput, locked update, OWNER/ADMIN, sequential lifecycle; currently updates status without financial work.
- `src/routes/index.js`: existing PUT/PATCH /api/v1/cycles/:id and group/auth conventions.
- `src/handlers/payment-transactions.js`: BUY_SHARE allows any equity account; exact cents, member IDs, components, signed postings and document counters.
- `src/handlers/interests.js`, `cycle-members.js`, `dashboard.js`: component-based balances; existing component metrics describe historical purchases; do not use them for distribution calculations.
- `src/handlers/transactions.js`: unrestricted active header voids; must protect declaration consistency according to the lifecycle decision.
- `migrations/018_scope_account_ledger.js`, `031_add_entry_accounts_and_document_number_index.js`, `036_support_transaction_voids.js`: positive components, signed postings, deferred balance checks, nullable legacy account references and reversal linkage.
- `migrations/028_add_member_assistance_expense_account.js`: current seeding template; 1100 loans, 1300 penalties, 1400 contributions, 3000 equity, 1000 cash. No distribution payable or retained earnings account.
- Member identity is COALESCE(component.user_id, header.user_id); legacy postings can be unassigned. No explicit generic equity-refundability or receivable-dispute field exists.

## Tasks & Acceptance

- [x] `migrations/037_create_cycle_distributions.js`: scoped distribution schema, amount/identity constraints, unique cycle/member, RLS, audit links, account roles and rollback protection; reuse equivalent accounts, reject ambiguous equivalents.
- [x] `src/services/cycle-distributions.js`: validate ledger attribution and account classification; exact allocation; closing and member journals; immutable summary retrieval and cash warning.
- [x] `src/handlers/cycles.js`: invoke declaration within existing locked transaction, preserve generated counters, return summary and idempotent results.
- [x] `src/handlers/cycle-distributions.js`, `src/routes/index.js`: group-scoped retrieval using established financial-reader authorization.
- [x] Relevant posting handlers and derived balance readers: enforce the resolved post-declaration policy without modifying unrelated behavior.
- [x] `test/cycle-distributions.test.js`, `test/cycle-distributions.integration.test.js`: cover requested scenarios with the updated outstanding-debt rejection policy, real deferred constraints, rollback, concurrency, isolation, losses, rounding, voids and no cash movement; update directly affected cycle tests.

Given valid ledger data, declaration must reconcile every member and account exactly. Given ambiguity or missing attribution, declaration must fail before persistent effects. Given repeated or concurrent calls, only one journal set and one member record may exist. Given loss allocation, entries must balance with no negative transaction components or payables.

## Implementation Notes

User resolved the accounting gates and authorized the practical dispute choice; proceeding with implementation. Database migrations will be created locally and tested on disposable PostgreSQL; production application remains outside this task.

## Spec Change Log

## Review Triage Log

- medium, patched: retrieval used separate READ COMMITTED snapshots; now uses a read-only repeatable-read transaction, matching existing financial reports.
- medium, patched: fallback BUY_SHARE classification could override explicit account roles; roles are authoritative and incompatible type/collectible classifications fail validation. Focused regression passes.
- false as an existing-path defect: custom loans are not offset automatically; existing payment code explicitly restricts loan repayments to account 1100. Documented reconciliation requirement instead of guessing eligibility.
- medium, patched: fully settled unsupported account movements were rejected before aggregation; zero net unsupported balances per member/account are now allowed.
- medium, patched: no operational classification guidance existed; docs/cycle-distributions.md describes normal chart defaults, explicit roles and operator reconciliation, without adding an unrequested public management API.
- medium, patched: equivalent-account tests added for alias reuse, conflicting reserved codes, duplicate equivalents and incompatible roles, with rollback assertions.
- medium, patched: added actual void-versus-declaration races in both request orders; computed capital matches the winning operation. Every business write route also tested after declaration.
- low, patched: added explicit closing, retrieval after closing and legacy distributing-without-declaration assertions.
- One independent reviewer completed. The two additional reviewer agents hit provider usage limits; their passes were unavailable. Primary agent completed remaining code inspection and focused verification.

## Verification

Focused allocation tests and real PostgreSQL distribution integration tests, plus directly affected cycle/metrics regressions. No unrelated full-suite runs. Verify git diff --check. Report migration, endpoint, calculation, accounting, assumptions and test results.

Verification so far: 82 affected handler tests pass; allocation/member tests pass; real PostgreSQL distribution integration covers offsets, capped residual debt, blockers, loss, no cash movement, repeat/concurrent requests, rollback and all business write routes.

Final verification: 82 existing affected handler tests, 3 allocation/classification tests, 4 member-balance tests and 3 dashboard tests pass. The focused PostgreSQL integration test also passes (93 tests total), covering real migrations, balanced journals, earnings/losses, capped loan deductions, blockers, void exclusions, RLS retrieval, concurrency, immutable audit rows, rollback, business route guards, account reuse and lifecycle compatibility. git diff --check passes. Full unrelated suite and production migration/deployment were not run.

Implementation notes: latest user revision permits loans deducted from proceeds, while contributions/penalties block declaration. No dispute workflow or payouts were introduced. Local migration 037 creates declaration/member tables and account classification; required accounts are reused or created transactionally at declaration. Documentation: docs/cycle-distributions.md.
