---
title: 'Read transaction entries'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add GET /api/v1/transactions/:transactionId/entries for authenticated OWNER and ADMIN users in the selected group, returning that transaction's transaction_entries.

</frozen-after-approval>

## Implementation Notes

- Small additive endpoint; no intent gaps, migrations, or external effects.
- Follow transaction-registers authorization and existing response conventions. Scope both parent lookup and entries to the resolved group. Return 404 for absent or other-group parents, 400 for invalid positive bigint IDs, and all entry fields ordered by id ascending. Preserve numeric strings.
- Add a dedicated handler, route, HTTP tests using the existing Knex runner fixture pattern, and README documentation.
- Implemented and verified: full suite 193 passed, 5 integration tests skipped after enabling local port binding for existing HTTP tests. Focused tests also passed after review improvements.

## Review Triage Log

- Low, patched: successful fixture now contains two entries, asserting the complete response and ascending SQL order.
- Low, patched: group-aware parent fixture now exercises an OWNER authorized in both groups receiving 404 for a transaction in the other group.
- Low, rejected: additional live-database numeric serialization coverage would require integration setup for an unchanged pg/Knex conversion path. Handler returns rows unchanged; HTTP tests verify bigint/decimal strings and existing SQL uses no numeric casts. No production defect identified; disproportionate to this additive read endpoint.
