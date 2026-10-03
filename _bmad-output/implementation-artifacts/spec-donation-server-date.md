---
title: 'Use the server timestamp for donations'
type: 'bugfix'
created: '2026-10-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Donation creation must work without a frontend date and use the server timestamp, including time, without conversion to Manila time. Remove client-date validation and let the existing database default populate occurred_at. Ignore legacy date fields so existing clients cannot override the server clock. Preserve authorization, account validation, and balanced atomic postings.

</frozen-after-approval>

## Implementation Notes

- No intent gaps or irreversible actions. Small change to the donation handler, README, and existing route/integration coverage. No migration required.
- Supersedes the required client date in spec-record-donation-endpoint.md.

- Targeted verification: 16 route tests passed; PostgreSQL integration test skipped because TEST_DATABASE_URL is unset.

## Review Triage Log

- Low, patched: integration assertion now brackets creation with database clock readings to verify timestamp freshness.
- Low, patched: route fixture supplies a database-default timestamp and asserts its full time survives the response, including legacy-date requests.
