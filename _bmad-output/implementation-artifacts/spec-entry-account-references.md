---
title: 'Entry account references and receipt lookup index'
type: 'feature'
created: '2026-10-06'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>
## Intent
Record debit and credit account IDs in transaction_entries to prepare for voiding. Index transactions.document_number for receipt lookups.
</frozen-after-approval>

## Implementation Notes
- Migration 031 adds nullable bigint account references with same-group foreign keys and a non-unique document_number index.
- Backfill entries only where postings identify exactly one distinct debit account and one distinct credit account. Ambiguous legacy entries retain nulls.
- All six entry creation flows populate both fields from validated account selections.
- Receipt lookup must still filter group, cycle and document type because numbers are not globally unique.
- Migration is prepared only, not applied to a database. No voiding endpoint is introduced.
- No subagent testing or review, following the user's session preference.
- Verification: 48 targeted tests passed, including entry references matching signed postings. Full suite: 136 passed, 10 failed in local HTTP server setup, 4 skipped. Migration syntax and diff checks passed. Live migration/backfill execution remains unverified.
