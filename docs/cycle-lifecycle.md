# Current and historical cycles

The current cycle is the group's single **non-closed** cycle. Creation date is
not used to decide which cycle is current. Groups may have no current cycle and
any number of closed cycles.

| Status | Meaning | Financial edits | Next status |
| --- | --- | --- | --- |
| `draft` | Preparing a new cycle | Allowed | `active` |
| `active` | Cycle in progress | Locked | `distributing` |
| `distributing` | Cycle ended; proceeds being paid out | Locked | `closed` |
| `closed` | Completed historical cycle | Locked; all API updates rejected | None |

Cycle creation and updates require an authenticated OWNER or ADMIN of the group
selected by `x-group-slug`. The API checks the locked database row, not the
client's claimed current state. The database's `cycles_one_current_per_group`
partial unique index enforces one non-closed cycle across all writers. Lifecycle
transitions and financial immutability are enforced by the HTTP handlers;
privileged direct SQL maintenance must respect those rules too.

## API flow and client changes

1. `POST /cycles` with financial settings, optionally `"status": "draft"`.
   Omitting the status also creates a draft. Creation with `active`,
   `distributing`, `closed`, or the removed `inactive` value returns 400.
2. `PATCH /cycles/:id` to edit the current draft's financial settings.
3. `PATCH /cycles/:id` with `{"status":"active"}` to activate it.
4. `PATCH /cycles/:id` with `{"status":"distributing"}` when the cycle ends.
5. When payouts are complete, `PATCH /cycles/:id` with `{"status":"closed"}`.
   This records a manager's confirmation; it does not execute or verify payouts.
6. Create the next draft. POST returns 409 until the previous current cycle closes.

The `/api/v1` aliases behave identically. Status values are lowercase.
Non-closed status-only retries are no-ops. Every update to a closed cycle returns
409, including repeating `closed`; history cannot be reactivated. Partial edits
preserve omitted fields, and failed updates change nothing.

`GET /groups/users` now reports membership in the non-closed cycle, even if a
closed cycle has a newer timestamp. When only historical cycles remain,
`current_cycle_id` is null and every `is_current_cycle_member` is false.

Clients must replace editable `inactive` state with `draft`, stop creating cycles
as active, provide a close action for distributing cycles, and hide edits and
status controls for closed history. Do not infer the current cycle from timestamps.

## Migration 012 and existing data

`012_current_cycle_lifecycle.js` supersedes migration 011 without modifying it.
The conversion uses a conservative historical-data policy:

- Existing `inactive` cycles become `closed`. The old schema cannot reliably
  distinguish finished cycles from unstarted cycles; migration never turns an
  unknown historical cycle into an editable draft.
- Existing `active` and `distributing` cycles keep their status.
- New inserts default to `draft`.
- Cycle IDs, group IDs, financial settings, memberships, and timestamps are
  preserved. Closing a legacy inactive row does not execute a payout.
- The restricted `comsca_group_reader` role gains SELECT on cycles.status so the
  current-cycle query continues to run under group RLS.

If a group has multiple active/distributing cycles, migration stops and rolls
back all changes. It does not guess which cycle is current or mark unpaid
cycles completed. Before deployment, run this read-only preflight against the
legacy schema:

```sql
SELECT group_id, count(*) AS ongoing_cycles,
       array_agg(id ORDER BY created_at, id) AS cycle_ids
FROM public.cycles
WHERE status IN ('active', 'distributing')
GROUP BY group_id
HAVING count(*) > 1;
```

Any result requires a reviewed data reconciliation before retrying. Establish
which cycles are actually completed; under the legacy schema, only confirmed
historical rows should be marked inactive for migration to close. Do not close
an ongoing cycle simply to satisfy the index.

## Deployment and rollback

This is a coordinated schema/API change, not a rolling compatibility release:

1. Back up the database and inspect the preflight results and inactive cycles.
2. Pause requests while applying migration 012 and deploying the updated backend.
   The migration takes an exclusive cycles-table lock within its transaction.
3. Update clients for the four-state lifecycle, then resume requests and verify
   group membership listing, draft creation, and existing ongoing cycles.

Use the project's configured migration command for the intended environment
(`npm run migrate:latest` locally, `npm run migrate:production` for production).
Installation of these code changes does not apply the migration automatically.

Rolling down restores migration 011's three-state schema and active-only unique
index. Both `draft` and `closed` map to `inactive`; that distinction is lost,
although IDs and other data remain. Status SELECT for the group reader is revoked.
Roll back the application together with the schema while traffic is paused.
The older application allows editing inactive historical cycles, so rollback
removes this protection. Reapplying migration 012 closes all those inactive rows,
including any former drafts; restore a backup if the exact prior classification
must be retained.
