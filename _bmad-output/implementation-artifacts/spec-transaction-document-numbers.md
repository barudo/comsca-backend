---
title: 'Store transaction document numbers'
type: 'feature'
created: '2026-09-27'
status: 'in-progress'
route: 'oneshot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Add migration 023 to store receipt, disbursement voucher and journal voucher identities on transactions. Use nullable document_type and positive bigint document_number fields, requiring both or neither. Ensure unique numbers per group/cycle/type, including a separate group/type scope for cycle-less transactions. Existing rows remain unnumbered. Preserve transaction business type and amounts. Include rollback and integration coverage. This request does not allocate numbers, modify endpoints or apply migrations to the application database.

</frozen-after-approval>

## Implementation Notes

- Added migration 023, documentation and PostgreSQL integration cases for valid scopes, invalid pairs/numbers, duplicates, updates and rollback.
- Database execution and privileged operations are blocked because the automatic approval service reached its usage limit. No application database has been modified.

- JavaScript syntax checks and eight existing endpoint tests passed; `git diff --check` passed. PostgreSQL integration tests were added but could not be executed.

## Review Triage Log

- Reviewer found no correctness defects in NULL checks, uniqueness scopes or compatibility.
- Low: cross-group number reuse is not directly exercised; both indexes explicitly include group_id. Additional coverage is optional and no functional defect was identified.
- Workflow remains in progress pending PostgreSQL verification; no local commit or migration application performed.
