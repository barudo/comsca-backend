---
title: 'Charge contributions to selected users'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Accept optional user_ids on POST /api/v1/contributions/charge to limit charges to the selected enrolled members. Omission retains charging the full current-cycle roster.

</frozen-after-approval>

## Implementation Notes

- Small reversible change to the contribution handler, tests and README; no migration or external side effects.
- Reuse positive-ID validation and locked group-scoped cycle roster. Reject empty/non-array lists and invalid IDs; deduplicate normalized IDs. Reject selections containing users outside the roster before any writes. Preserve freeze checks, authorization, accounting and voucher allocation.
- Updated handler, README, unit tests and database integration rejection coverage. Full suite passed 239 tests with 10 database suites skipped; after review patches, all 13 contribution tests passed and database integration remained skipped without TEST_DATABASE_URL. Build and diff whitespace checks passed.

## Review Triage Log

- Low, patched: explicit selections on an empty roster now return the documented 400; omitted selection retains 409.
- Medium, patched: added database integration rejection checks for mixed eligible and unenrolled, historical-cycle or other-group selections, asserting unchanged accounting counts and voucher sequence. Execution requires TEST_DATABASE_URL.
- Low, patched: added successful bigint string selection and selected-population amount overflow coverage.
