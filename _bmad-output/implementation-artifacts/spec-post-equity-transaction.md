---
title: 'Post an equity transaction with selected accounts'
type: 'feature'
created: '2026-09-27'
status: 'done'
route: 'oneshot'
context: ['docs/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Implement `POST /api/v1/transactions/equity` using the existing signed ledger. Accept `debit` (one ASSET account ID), `credit` (one EQUITY account ID), a positive decimal `amount`, optional `cycle_id`, `user_id`, and `description`. Resolve the group from `x-group-slug` and verify bearer authentication. OWNER, ADMIN and TREASURER may post; other roles and users outside the group may not.

Infer the cycle from the selected cycle-owned accounts when omitted; an explicit cycle must be in the group and match both scoped accounts. Preserve nullable group accounts and group transactions. A member requires a cycle and membership in it. Existing historical cycles are valid, consistent with the agreed transaction rules. Use scalar IDs; multiple allocations require explicit per-account amounts and are not part of this endpoint.

Atomically create a positive EQUITY transaction header, one EQUITY business component, and two account postings: debit +amount, credit -amount. Validate referenced accounts and amounts before writing. Keep monetary calculations exact and lock authorization/reference records against concurrent reassignment or type changes. Return HTTP 201 with the saved transaction, components and account postings only after commit. Reject malformed input with 400, unauthorized access with 403, unavailable references with 404, and concurrent/database constraint conflicts with a sanitized 409. Do not alter schema, deploy or touch the application database.

</frozen-after-approval>

## Implementation Notes

- Existing migrations 018–021 support this request directly; debit/credit are API fields translated into signed account postings.
- Implementation footprint: equity handler and route, request and PostgreSQL integration tests, README contract.
- The one-account-per-side shape was stated to the user; an optional clarification asks whether multiple allocations are required. No answer is required to build this initial shape.

- Implemented the handler, authenticated route, request tests, PostgreSQL persistence/rollback/concurrency tests, and README request contract. No schema changes.
- Final verification: 90 tests passed, zero failures/skips on a fresh disposable PostgreSQL 18 instance; `git diff --check` passed.
- User confirmed the immediate atomic posting design after the initial implementation was interrupted. Resumed from the existing files.

## Review Triage Log

| Finding | Verdict and evidence | Resolution |
|---|---|---|
| Large JSON-number amounts can lose cents before parsing | High: 90071992547409.91 parses to 90071992547409.9. | Require strings above a conservative 1e12 threshold; raw-JSON regression rejects the rounded input. |
| Database rollback test only covered BEFORE INSERT failures | Medium: deferred constraints can fail at commit after the callback returns. | Added real deferred trigger failure, sanitized 409 and unchanged counts across all three tables. |
| Authorization/account concurrency not tested | Medium: locking promises require real connection contention. | Separate connection waits for locked actor/account updates, then rejects committed AUDITOR/INCOME changes. |
| Explicit cycles and mixed account scopes untested | Medium: nullable group accounts may accompany scoped accounts. | Added both mixed directions, scoped pairs and group pairs with explicit cycle/member attribution. |
| Foreign-group member/cycle cases missing | Medium: financial writes must reject valid IDs from another group. | Added both PostgreSQL cases with sanitized 404 responses. |

All review findings addressed; nothing deferred.
