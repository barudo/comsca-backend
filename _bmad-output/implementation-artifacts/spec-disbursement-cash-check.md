---
title: 'Require sufficient Cash for loan disbursement'
type: 'feature'
created: '2026-10-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Require the selected credit account to be Cash (1000), ASSET, for POST /api/v1/transactions/disburse-loans. Reject disbursement with 409 when its available ledger balance is less than the requested amount, leaving vouchers, accounting records and applications untouched. Allow exact-balance disbursements. Preserve decimal precision and serialize concurrent disbursements.

</frozen-after-approval>

## Implementation Notes

- Uses signed account_entries for the selected account/group, consistent with existing accounting reports, including all recorded postings. No migration or live data operation.
- Existing current-cycle FOR UPDATE lock serializes disbursements before the balance check. SQL numeric comparison avoids JavaScript precision loss.
- Added request tests and optional PostgreSQL funding/concurrency regression coverage.

- Verification: full suite 168 passed, 4 skipped; focused disbursement tests 13 passed. PostgreSQL integration scenarios added but not run without a disposable database.
- Lock guarantee applies to concurrent disbursements through this endpoint; this change does not impose a global nonnegative-balance invariant on other accounting endpoints.

## Review Triage Log

- low, patched: existing README cycle wording contradicted current-cycle selection; corrected it.
- low, patched: PostgreSQL rejection tests lacked state snapshots; added counter, application, and accounting count comparisons plus concurrent winner assertions.
- low, patched: PostgreSQL Cash-only coverage lacked another valid ASSET; added rejection of Penalties Receivable with unchanged-state assertions.
