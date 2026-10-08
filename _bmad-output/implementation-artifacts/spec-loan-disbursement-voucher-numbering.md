---
title: 'Loan disbursement voucher numbering'
type: 'feature'
created: '2026-10-08'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>
## Intent
POST /api/v1/transactions/disburse-loans allocates the next disbursement_voucher_counter from the group's current cycle, updates that counter, and saves the allocated document_number with document_type DISBURSEMENT_VOUCHER.
</frozen-after-approval>

## Implementation Notes
- Use the existing current writable cycle convention: active or distributing, newest created_at/id first. Lock the cycle for update and require account and optional input cycle IDs to match.
- Increment using database bigint arithmetic inside the same transaction as the ledger inserts. Return both document fields. Failed inserts or commits roll back counter allocation.
- Existing migrations already support the counter and document type; no schema migration is needed.
- Nine targeted tests pass, covering sequence allocation, bigint precision, posting and commit rollback, cycle eligibility, account scope and authorization. Diff checks pass. Live database concurrency was not tested.
- No subagent testing or review, following the session preference.
