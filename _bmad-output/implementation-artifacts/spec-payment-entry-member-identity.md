---
title: 'Set payment entry member and cycle identity'
type: 'bugfix'
created: '2026-09-29'
status: 'in-progress'
route: 'oneshot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

POST /api/v1/transactions/payments must set user_id and cycle_id on every newly inserted transaction entry to the validated member and resolved cycle of its parent transaction.

</frozen-after-approval>

## Implementation Notes

Existing migration 027 provides the nullable columns and group/member/parent-cycle foreign keys. The handler already validates membership and resolves the cycle before inserting. Added the two fields to the insert and assertions to existing request and PostgreSQL mixed-payment tests. No migration or historical backfill is needed.
