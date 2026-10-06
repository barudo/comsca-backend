---
title: 'Payment receipt numbering'
type: 'feature'
created: '2026-10-06'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>
## Intent
Allocate the next receipt_counter from the group's active cycle when recording a payment. Save it as the transaction document_number with document_type PAYMENT_RECEIPT.
</frozen-after-approval>

## Implementation Notes
- Lock the active cycle and increment its counter inside the payment database transaction; one number per header, including multi-entry payments.
- Validate supplied cycle and account cycles against the active cycle.
- Add migration 030 to permit PAYMENT_RECEIPT while retaining existing document types. Migration execution is left to deployment.
- Return both document fields. Preserve bigint precision with database arithmetic.
- Testing and review performed locally without subagents per user preference.
- Verification: 23 targeted tests passed; migration syntax and git diff whitespace checks passed. Database migration and live concurrency testing were not run. Local review confirmed counter allocation and ledger writes share one transaction.
