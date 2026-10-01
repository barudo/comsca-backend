---
title: 'Current User Transaction Entries'
type: 'feature'
created: '2026-10-02'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Authenticated members have no endpoint to retrieve their transaction entries.

**Approach:** Add `GET /api/v1/me/transactions` returning `{ success: true, data: [...] }` for transaction entries associated with the authenticated user in the group selected by `x-group-slug` and its current active or distributing cycle. Resolve entry ownership and cycle from the parent transaction when those entry fields are null. Return entries newest transaction first, preserve `amount` as an exact decimal string, and return an empty data array when no active or distributing cycle exists.

</frozen-after-approval>

## Implementation Notes

The user's follow-up clarified that results are limited to the selected group's active or distributing cycle. The endpoint orders entries by parent transaction `occurred_at`, transaction ID, and entry ID descending. It resolves legacy ownership and cycle from the parent transaction when entry fields are null, returns the effective IDs, and casts amounts to exact decimal strings. Each row includes the parent's `occurred_at` as `transaction_occurred_at`; with no active/distributing cycle, it returns an empty data array.

## Review Triage Log

- low — The endpoint ordered by parent `occurred_at` without returning it, preventing clients from displaying the ordering timestamp; it now returns `transaction_occurred_at` and the README documents it.
- low — The README omitted the schema prerequisite; it now documents migration 027.
- low — The README overstated `no-store` for pre-authentication group-resolution errors; it now limits the guarantee to authenticated responses and notes early group errors.
- maybe-false — The mock test did not behaviorally verify null entry-user fallback; the existing PostgreSQL integration fixture now asserts the resolved user ID, but that integration test was skipped locally because `TEST_DATABASE_URL` is unavailable.
