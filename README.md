# Comsca Backend

Express API configured for AWS Lambda.

## BMAD development workflow

BMAD Method 6.12.0 (core + BMM) is installed for Codex in `.agents/skills/`.
Open a fresh Codex session in this repository to discover the skills, then use:

- `$bmad-help` for guidance on the next workflow.
- `$bmad-build` followed by a feature or bug description to implement a change.
- `$bmad-code-review` to review a change.

BMAD scripts require `uv` (`brew install uv` on macOS). Project context lives in
[`docs/project-context.md`](docs/project-context.md). Planning and implementation
artifacts go under `_bmad-output/`; shared configuration lives in `_bmad/`.
Put durable team overrides in `_bmad/custom/config.toml`; personal
`config.user.toml` files are gitignored. BMAD files are excluded from Lambda.

Reinstall the pinned version from the project root:

```bash
npx bmad-method@6.12.0 install --modules bmm --tools codex --yes \
  --set core.project_name=comsca-backend --set bmm.project_knowledge=docs
```

Verify configuration:

```bash
uv run _bmad/scripts/resolve_config.py --project-root "$PWD"
```

## Run locally

```bash
npm install
npm start
```

The API base URL is `http://localhost:3000/api/v1`. Use the endpoint paths documented below.

## Routing and handlers

All endpoints are registered explicitly in `src/routes/index.js`, which is mounted
once by `src/app.js`. Add routes and their aliases there; route files are not
automatically discovered. Request logic lives in classes under `src/handlers/`
(for example, `CyclesHandler.list`, `.create`, and `.update`). Bind handler methods
to their instances when registering them, and keep request-specific state local
to each method. Database and service dependencies come from `request.app.locals`.

The registry puts raw webhook parsing before JSON parsing, public registration
and Supabase authentication before group resolution, and group-scoped endpoints
after it. The legacy username login and auth index still require a group header.
All registered routes must start with `/api/v1`; unversioned paths return `404`.

## Database migrations

The project uses Knex migrations with PostgreSQL. Copy `.env.example` to `.env`
and set the database values, then run:

```bash
npm run migrate:latest
```

To roll back the latest migration:

```bash
npm run migrate:rollback
```

The initial migration creates groups, users, cycles, and cycle membership tables.
Users and cycles belong to a group, while `cycle_members` links users to cycles.

Migration `012_current_cycle_lifecycle.js` replaces migration 011's legacy
`inactive` status with `draft` and `closed`. The lifecycle is:

`draft → active → distributing → closed`

The **current cycle** is the group's only non-closed cycle, regardless of its
creation date. PostgreSQL enforces at most one non-closed cycle per group,
including competing requests. Past/closed cycles are read-only through the API.
New cycles start as drafts; another draft cannot be created until the current
cycle is closed. See [cycle lifecycle deployment](docs/cycle-lifecycle.md) for
migration conversion, preflight checks, API compatibility changes, and rollback.

## Get the latest current cycle

`GET /api/v1/cycles` requires a Bearer token and an
OWNER/ADMIN database profile in the group selected by `x-group-slug`.
Apply migrations through `017_add_cycle_subscription_and_share_limit.js` before deploying this
endpoint; migration 016 grants the existing RLS reader access to `name`,
`description`, `absence_penalty`, and `required_monthly_contribution` without
changing group isolation.

```http
GET /api/v1/cycles
Authorization: Bearer <access-token>
x-group-slug: your-group
```

Returns HTTP 200 with `{ "success": true, "current_cycle_id": "7", "cycles": [...] }`.
The `cycles` array contains at most one cycle: the latest with status `draft`,
`distributing`, or `active`, ordered by `created_at DESC, id DESC`. Closed cycles
are excluded before selecting the latest result.
Each cycle includes `id`, `group_id`, `interest_rate`, `interest_period`,
`interest_method`, `cost_per_share`, `status`, `created_at`, `updated_at`, `name`,
`description`, `absence_penalty`, `required_monthly_contribution`,
`starting_subscription`, and `maximum_monthly_shares`.
Decimals retain PostgreSQL's string representation. The current ID is the returned
cycle's ID. When no matching cycle exists (including groups with only closed
cycles), the response contains `cycles: []` and `current_cycle_id: null`.

Missing group header returns 400, missing/invalid authentication 401, callers
without OWNER/ADMIN membership in that group 403, and an unknown group 404.
Responses use `Cache-Control: no-store`. Query parameters do not change group
selection, filtering, or ordering. The list query runs under PostgreSQL RLS with
transaction-local group context. No request body is needed.

## Create a cycle

API convention: use `/api/v1/` for all new endpoints; do not add unversioned aliases.

`POST /api/v1/cycles` requires a Bearer token and an OWNER or
ADMIN database profile in the group selected by `x-group-slug`.
Apply migrations through `017_add_cycle_subscription_and_share_limit.js` before deploying this version.

```http
POST /api/v1/cycles
Authorization: Bearer <access-token>
x-group-slug: your-group
Content-Type: application/json

{
  "name": "2026 Savings Cycle",
  "description": "Monthly group savings",
  "absence_penalty": "50.00",
  "required_monthly_contribution": "500.00",
  "interest_rate": "2.500000",
  "interest_period": "MONTHLY",
  "interest_method": "COMPOUND",
  "cost_per_share": "100.00",
  "status": "draft"
}
```

- `name`: optional/null string, at most 255 characters.
- `description`: optional/null text string. Neither text field accepts NUL characters.
- `absence_penalty` and `required_monthly_contribution`: optional/null,
  nonnegative currency amounts with at most 16 integer digits and 2 decimal
  places (`numeric(18,2)`). Zero is valid.
- `interest_rate`: nonnegative decimal, at most 3 integer digits and 6 decimal
  places (`numeric(9,6)`). Zero is valid.
- `interest_period`: `DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`.
- `interest_method`: `SIMPLE` or `COMPOUND`.
- Supply all three interest fields together, or leave all three null/omitted.
- `cost_per_share`: optional/null, otherwise greater than zero, at most 16
  integer digits and 2 decimal places (`numeric(18,2)`).
- `status`: optional; if supplied it must be `draft`. All other values are rejected.

Decimals accept JSON numbers or fixed-point decimal strings. Numeric inputs are
validated after JavaScript JSON parsing, which can round the original value;
use strings for exact monetary values and exact decimal-place validation.
Scientific notation in strings and excess decimal places are rejected.
Amounts above JavaScript's safe integer range must be
sent as strings. `{}` creates a draft cycle with unset financial settings.
The group comes from the header; client-supplied `group_id`, IDs, timestamps,
and other unsupported fields are rejected.

Success returns HTTP 201 with `{ "success": true, "cycle": { ... } }`, including
the saved ID, group ID, name, description, financial settings (including the two
new currency fields), status, and timestamps. These new fields are supported by
creation, listing, and updates. Invalid input
returns 400, missing/invalid authentication 401, missing group membership or an
unauthorized role 403, unknown group 404, and an existing non-closed cycle in the
same group 409. `current_cycle_id` in the group-user listing identifies the sole
non-closed cycle, never a newer historical row.

## Update a cycle

Use `PUT /api/v1/cycles/:id` to update a cycle, including status changes:

```http
PUT /api/v1/cycles/20
Authorization: Bearer <access-token>
x-group-slug: your-group
Content-Type: application/json

{ "status": "active" }
```

PUT uses the same partial-update behavior, authorization, and lifecycle rules as
PATCH below. There is no unversioned PUT alias. Allowed forward transitions are
`draft` → `active` → `distributing` → `closed`.

`PATCH /api/v1/cycles/:id` requires a Bearer token and
an OWNER or ADMIN database profile in the group selected by `x-group-slug`.
It returns HTTP 200 with `{ "success": true, "cycle": { ... } }`.

All cycle detail fields are accepted: `name`, `description`, the interest fields,
`cost_per_share`, `absence_penalty`, `required_monthly_contribution`,
`starting_subscription`, and `maximum_monthly_shares`. Detail edits require a
`draft` cycle. `starting_subscription` is nullable nonnegative currency with
at most 16 integer digits and 2 decimal places; `maximum_monthly_shares` is a
nullable JSON integer from 1 to 2147483647. These two fields are also accepted
on creation and returned by GET. Apply migrations through 017 before deployment.

Send only the fields to change. Financial fields use the same values and decimal
limits as creation. Omitted fields retain their saved values; the resulting
interest settings must still contain either all three fields or three nulls.
An empty object is rejected. IDs, group IDs, timestamps, and unknown fields cannot
be set by the client.

| Saved status | Financial edits | Allowed next status |
| --- | --- | --- |
| `draft` | Allowed | `active` |
| `active` | Rejected | `distributing` |
| `distributing` | Rejected | `closed` |
| `closed` | Rejected | None (all updates rejected) |

For example, edit a draft cycle with `{ "cost_per_share": "150.00" }`,
activate it with `{ "status": "active" }`, then begin distribution with
`{ "status": "distributing" }`. After payouts are complete, close it with
`{ "status": "closed" }`; a new draft can then be created. Closing records the
manager's confirmation; this endpoint does not calculate or verify payouts.
Status values are lowercase. Financial edits may accompany activation of a draft
in the same atomic request.
Financial fields on active/distributing cycles are rejected even if the supplied
values match their current values. Status-only requests repeating the saved
non-closed status succeed without writing or changing `updated_at`. Every PATCH
on a closed cycle returns 409, including status-only retries, empty requests,
and attempts to reactivate it.

Invalid input or a missing `x-group-slug` header returns 400; an unknown group
slug returns 404. Missing/invalid authentication returns 401, a caller without
OWNER/ADMIN membership in the selected group 403, and a missing or other-group
cycle 404. Invalid transitions, financial edits to a frozen cycle, and attempts
to activate a second cycle in the same group return 409. Failed requests leave
all cycle fields unchanged. Successful writes refresh `updated_at` and preserve
`created_at`. The actor and cycle are locked within the transaction so role
revocation and simultaneous status changes cannot bypass these checks.
This version requires migration 012; see the deployment notes linked above.

## Financial migrations

Migration `005_create_transactions.js` adds business transactions. Every transaction
requires a `group_id`, a positive `amount` (18 digits, including 2 decimal places),
and a `type` in uppercase snake case. Suggested types are `EQUITY`,
`LOAN_DISBURSEMENT`, `LOAN_PAYMENT`, `ADD_PAYABLE`, `ADD_PENALTY`, `DISBURSEMENT`,
and `OTHER_SALES`; additional types are supported without a migration. The amount
is a magnitude; the type describes the operation, including non-cash operations.

For group-wide transactions, leave `user_id` null; `cycle_id` is optional.
For member transactions, supply both `cycle_id` and `user_id`. Foreign keys enforce
that the cycle and user belong to the transaction's group and that the user is a
member of that cycle. Referenced groups, cycles, users, and memberships cannot be
deleted while transactions exist. Optional `description` and `occurred_at` record
context and the business event time; `occurred_at` defaults to now. `created_at`
and `updated_at` also default to now; writers must maintain `updated_at` on edits.
Row level security is enabled with no public API policies, matching existing tables.

Migrations `018_scope_account_ledger.js` and `019_seed_cycle_accounts.js` separate
business components from accounting postings. `transactions` remain headers;
`transaction_entries` contain `type`, positive exact decimal `amount`, description,
and timestamps. Read member breakdowns by joining these two tables, without accounts.
`account_entries` link a component to an account with a signed `amount`: positive
is debit, negative is credit. Money uses `numeric(18,2)` throughout.

Migration `021_validate_account_entries_after_changes.js` makes child-trigger validation run after mutations, including when constraints are explicitly set to immediate.

Save headers, components and postings in one database transaction. Deferred checks
require component amounts to sum to the header, and each component's debit and
credit totals to equal its amount. Parent writes serialize competing changes;
callers must retry serialization failures or deadlocks. Group and membership
foreign keys remain enforced. Historical cycles are valid; group operations may
omit both member and cycle. A cycle account only accepts its own cycle's postings;
nullable-cycle group accounts accept group or cycle activity. Account group/cycle
ownership is immutable, and account codes are unique within their group/cycle scope.
All ledger tables enable RLS. Migration `020_allow_cycle_accounts_read.js` grants group-scoped account reads to the restricted backend reader role; it grants no access to ledger postings.

Activating a cycle atomically creates the following chart, also backfilled for
existing active/distributing cycles. Newly created accounts start with zero balances; existing backfilled accounts retain their postings. Closed
history is retained without a new chart or balance carryover. Repeated activation
preserves existing accounts; incompatible reserved names/types abort activation.

| Code | Account | Type |
| --- | --- | --- |
| 1000 | Cash | ASSET |
| 1100 | Loans Receivable | ASSET |
| 1300 | Penalties Receivable | ASSET |
| 1400 | Contributions Receivable | ASSET |
| 2000 | Accounts Payable | LIABILITY |
| 3000 | Equity | EQUITY |
| 4000 | Interest Income | INCOME |
| 4100 | Penalty Income | INCOME |
| 4200 | Other Income | INCOME |
| 4300 | Donation Income | INCOME |
| 4400 | Contribution Income | INCOME |
| 5000 | Operating Expenses | EXPENSE |

Migration `025_remove_interest_receivable_from_cycle_defaults.js` removes Interest
Receivable (1200) from the activation template, reducing it to ten accounts.
Existing accounts and postings are preserved. Rolling
back restores the eleven-account template for subsequent seeding; it does not
backfill accounts into existing cycles.
After rollback, a later status update to `active` or `distributing` seeds the
restored template, adding Interest Receivable if that cycle does not have it.

Migration `026_add_contribution_cycle_accounts.js` adds Contributions Receivable
(1400, ASSET) and Contribution Income (4400, INCOME), producing the twelve-account
template above. The migration updates future seeding without backfilling existing
cycles. Later activation or transition to distributing seeds any missing defaults.
Rollback restores the ten-account template but preserves existing accounts and
postings. Incompatible pre-existing definitions for these reserved codes cause
activation to fail atomically rather than overwrite custom accounts.

For non-refundable contributions recorded as owed before collection, the intended
posting is debit Contributions Receivable and credit Contribution Income. On
collection, debit Cash and credit Contributions Receivable. This migration adds
the accounts only; it does not create accruals or add a contribution-payment API.

A payment header of 1,100 can contain these independently balanced components:

| Component | Amount | Debit (+) | Credit (-) |
| --- | ---: | --- | --- |
| LOAN_PRINCIPAL | 1,000 | Cash 1,000 | Loans Receivable -1,000 |
| PENALTY | 100 | Cash 100 | Penalty Income -100 |

For a loan disbursement of 1,000, create one component for 1,000, debit Loans
Receivable 1,000 and credit the selected funding asset -1,000. Previously accrued
penalties credit Penalties Receivable instead. Posting rules are the writer's
responsibility; no automatic type rules or ledger API are added. Derive balances
from signed postings (reverse the sign for liabilities, equity and income).

Legacy debit/credit rows become physical account postings, preserving IDs, values,
descriptions and timestamps. One aggregate component uses each header's type and
amount; no historical split is guessed. Referenced account definitions are cloned
into known historical cycles, retaining original group accounts for cycle-less
history. Migration aborts if legacy totals disagree with headers. Writers must
switch from the old debit/credit entry shape when applying these migrations;
there is no second writable posting representation. Rollback of 019 retains all
accounts. Rollback of 018 rejects cycle ownership or component data that the old
schema cannot preserve; use a verified backup for incompatible downgrades.

`POST /api/v1/transactions/disburse-loans` records a loan issued to a member.
Requires a Bearer token and `x-group-slug`; OWNER, ADMIN and TREASURER may post.

```json
{
  "user_id": "12",
  "cycle_id": "7",
  "debit": "102",
  "credit": "101",
  "amount": "5000.00",
  "description": "Member loan disbursement"
}
```

Use actual account IDs from `GET /api/v1/cycles/accounts`. `debit` must be Loans
Receivable (code `1100`, ASSET); `credit` must be a different ASSET account used
to fund the loan, such as Cash (code `1000`). `user_id`, `debit`, `credit`, and
`amount` are required. `cycle_id` can be omitted when inferred from the accounts;
the member must belong to that cycle and group. All cycle-owned accounts must
match the selected cycle; group accounts and historical cycles are supported.

Amounts must be positive with at most two decimal places and fit numeric(18,2).
Use strings for exact amounts; JSON numbers above 1,000,000,000,000 are rejected.
IDs accept decimal strings or safe positive integers. The optional description
allows up to 4000 characters. Unknown fields are rejected. The API body limit is
32 KiB (413 when exceeded).

Returns 201 with `{success:true,transaction,entries,account_entries}` after
atomically creating one `LOAN_DISBURSED` header and component, a positive Loans
Receivable posting and a negative funding-account posting. Historical records
using `LOAN_DISBURSEMENT` are not renamed. This endpoint does not calculate
interest, enforce funding balances or loan limits, allocate voucher numbers, or
deduplicate repeated requests. Errors follow the payments endpoint below.

`POST /api/v1/transactions/payments` replaces the equity endpoint and records a
member payment. Supply a Bearer token and `x-group-slug`; only the group's OWNER,
ADMIN or TREASURER can post. The frontend supplies the member's `user_id` and
one or more entries with selected account IDs:

```json
{
  "user_id": "12",
  "cycle_id": "7",
  "description": "Monthly payment",
  "entries": [
    { "type": "LOAN_PAYMENT", "debit": "101", "credit": "102", "amount": "600.00" },
    { "type": "BUY_SHARE", "debit": "101", "credit": "106", "amount": "300.00" },
    { "type": "PENALTY_PAYMENT", "debit": "101", "credit": "104", "amount": "100.00" }
  ]
}
```

Replace sample IDs with accounts from `GET /api/v1/cycles/accounts`. Each entry
requires `type`, `debit`, `credit`, and a positive `amount`; its optional
`description` may contain up to 4000 characters. There must be 1–100 entries,
and the entire JSON body must fit the API's 32 KiB limit (otherwise HTTP 413).
The debit must be an ASSET account, different from the credit account.
Credit account rules are:

| Entry type | Credit account |
| --- | --- |
| `LOAN_PAYMENT` | Loans Receivable: code `1100`, ASSET |
| `BUY_SHARE` | An EQUITY account |
| `PENALTY_PAYMENT` | Penalties Receivable: code `1300`, ASSET; or Penalty Income: code `4100`, INCOME |

A loan payment is a single amount against combined principal and accrued
interest; the endpoint does not split it or calculate interest. Select Penalties
Receivable to settle a previously accrued penalty, or Penalty Income to recognize
one directly. This endpoint does not calculate outstanding balances or enforce
loan/penalty payoff limits.

Amounts allow at most two decimal places. Use decimal strings for exact amounts;
JSON numbers above 1,000,000,000,000 must be strings. The backend sums entries
exactly and rejects totals exceeding `9999999999999999.99`. Do not supply a
header `amount`, `type`, `group_id`, or account postings. IDs may be decimal
strings or safe positive integers. The header description is optional.

The member must belong to the selected group and cycle. Supply `cycle_id`, or
let the backend infer it from the selected accounts. All cycle-owned accounts
must match that cycle. Group accounts can be used with an explicit cycle or
alongside accounts from that cycle. Historical cycles remain accepted.

Returns HTTP 201 with `{success:true,transaction,entries,account_entries}` only
after commit. The PAYMENT header contains the sum of component amounts. Each
component has its own positive debit and negative credit postings. A failure
rolls back all components and postings. The old `/api/v1/transactions/equity`
route is removed. Each successful request creates a new payment; automatic retry
deduplication, share quantities, and receipt-number allocation are not included.

Errors: 400 invalid input/types/membership; 401 unauthenticated; 403 unauthorized
writer; 404 reference not found in the selected group; 409 database constraint
or concurrent-write conflict. No new migration is required for this endpoint.

`POST /api/v1/interests/charge` charges one full configured interest period on
each eligible member loan in the current active or distributing cycle. Only an
OWNER, ADMIN or TREASURER of the selected group may charge. Supply the debit
Loans Receivable asset account and the credit Interest Income account; both IDs
must be distinct, belong to the selected group, and be either group-scoped or
owned by the current cycle:

```json
{ "debit": "102", "credit": "108" }
```

The cycle must have `interest_rate`, `interest_period`, and `interest_method`
configured. The rate is a percentage per period; DAILY, WEEKLY, MONTHLY, and
YEARLY select the period but do not trigger elapsed-time calculations. SIMPLE
applies the rate to outstanding principal. COMPOUND applies it to principal
plus unpaid accrued interest. Each chronological `LOAN_PAYMENT` is applied to
unpaid interest first, then principal. Each member's result is rounded to cents
using PostgreSQL numeric rounding, and the header amount is the sum of those
rounded member entries.

Returns HTTP 201 with `{success:true,transaction,entries,account_entries}` after
atomically writing one `LOAN_INTEREST` header, one positive member entry per
borrower with chargeable rounded interest, and balanced debit/credit postings.
Every successful request charges another full period; there is no elapsed-time
check or duplicate suppression. Missing interest terms, no positive outstanding
loan, or interest that rounds to zero returns 409 without writes. Invalid input
or account types return 400, unauthenticated requests 401, unauthorized writers
403, and accounts not found in the selected group 404. Database constraint and
concurrency failures return 409 and roll back all records. No migration is
required.

`POST /api/v1/cycles/members` enrolls users into the selected group's current
cycle (draft, active, or distributing). Requires a Bearer token, `x-group-slug`,
and an OWNER or ADMIN profile in that group.

```json
{ "users": ["12", "13"] }
```

Accepts 1–1000 positive user IDs as strings or safe JSON integers. Every user must
belong to the selected group; unavailable/foreign users reject the entire batch.
Duplicates and existing memberships are ignored, preserving enrollment timestamps.
No cycle ID is supplied: the server resolves and locks the current cycle. Returns
HTTP 200 after commit, including on retries:

```json
{ "success": true, "current_cycle_id": "20", "users": ["12", "13"], "added_count": 2 }
```

`users` contains the deduplicated requested IDs; `added_count` counts new rows only.
Malformed input is 400, unauthenticated requests 401, unauthorized callers 403,
unavailable users 404, and missing current cycle/concurrent-write conflicts 409.
Historical cycle memberships are unchanged. No migration is required.

`GET /api/v1/cycles/accounts` returns the selected group's current cycle accounts,
ordered by code then ID. Supply `Authorization: Bearer <access_token>` and
`x-group-slug`. The verified user must be an OWNER, ADMIN, TREASURER, or AUDITOR
of that group. Group/cycle query parameters cannot override the scope.

```json
{
  "success": true,
  "current_cycle_id": "20",
  "accounts": [
    {
      "id": "100", "group_id": "1", "cycle_id": "20",
      "code": "1000", "name": "Cash", "type": "ASSET",
      "description": null,
      "created_at": "2026-09-27T00:00:00.000Z",
      "updated_at": "2026-09-27T00:00:00.000Z"
    }
  ]
}
```

Current means draft, active, or distributing, as elsewhere in the API. Without a
current cycle the response is `{"success":true,"current_cycle_id":null,"accounts":[]}`.
A newly created draft has no basic accounts until activation. Historical-cycle
and cycle-less group accounts are excluded. This endpoint returns definitions,
not calculated balances. Responses are not cacheable. Missing authentication is
401; an unauthorized role or membership is 403.

### Dashboard

`GET /api/v1/dashboard` returns financial and membership totals for the selected
group's current active or distributing cycle. It requires a Bearer token and
`x-group-slug`; OWNER, ADMIN, TREASURER, and AUDITOR are allowed. Group and cycle
query parameters do not change the resolved scope.

```json
{
  "success": true,
  "current_cycle_id": "20",
  "cash_on_hand": "1000.00",
  "outstanding_loans": "500.00",
  "total_fund_value": "1500.00",
  "share_capital": "300.00",
  "contributions_collected": "200.00",
  "contributions_due": "50.00",
  "active_members": 4
}
```

Monetary values are exact decimal strings. Cash on Hand is the balance of the
cycle's Cash account (code `1000`). Outstanding Loans are loan disbursements and
interest less loan payments. Total Fund Value sums balances of all cycle ASSET
accounts, including receivables and excluding liabilities. Share Capital sums
`BUY_SHARE`; Contributions Collected sums `PAY_CONTRIBUTION`; Contributions Due
sums `CHARGE_CONTRIBUTION` and legacy `CONTRIBUTION`, less `PAY_CONTRIBUTION`.
Active Members counts enrollments in that cycle. With no active or distributing
cycle, `current_cycle_id` is null and all monetary totals are `"0.00"` with
`active_members: 0`. Missing/invalid authentication returns 401; a missing
financial role in the selected group returns 403. A missing group header
returns 400, and an unknown group slug returns 404. Responses use
`Cache-Control: no-store`.

Migration `023_add_transaction_document_numbers.js` adds nullable `document_type`
and `document_number` fields to transactions. Both must be present together or
both absent. Types are `RECEIPT`, `DISBURSEMENT_VOUCHER`, and `JOURNAL_VOUCHER`;
the number is a positive bigint sequence, not a formatted string. Each type has
its own numbering within a group/cycle; cycle-less group transactions have a
separate unique group/type sequence. Display prefixes can be derived, e.g.
`C12-DV-000001`. Existing rows remain unnumbered; no historical numbers are invented.
This migration stores and protects assigned numbers; it does not increment cycle
counters or change the equity endpoint. Allocation must be implemented atomically
with posting. Rollback deletes document-number fields and their values.

Migration `022_add_cycle_document_counters.js` adds `receipt_counter`,
`disbursement_voucher_counter`, and `journal_voucher_counter` to cycles. Each is
a nonnegative, non-null bigint defaulting to zero for existing and new cycles.
The value represents the last allocated document number (zero means none).
Migration `024_allow_cycle_document_counters_read.js` grants the restricted reader
access to these counters. `GET /api/v1/cycles` includes all three on each returned
cycle as decimal strings (for example `"receipt_counter":"12"`), preserving bigint
precision. OWNER/ADMIN callers may supply counters in `POST /api/v1/cycles` and
`PUT /api/v1/cycles/:id` (also PATCH). Omitted creation counters default to zero;
omitted update counters retain their values. Counters accept nonnegative integers
through 9223372036854775807; use strings above the safe JSON integer range.
Counters may be edited in draft, active, or distributing cycles; closed cycles
remain read-only. Setting counters does not itself issue or renumber documents.
This migration does not allocate numbers or add document fields to transactions.
Future allocation should increment the relevant counter atomically in the same
database transaction as the numbered document. Rollback removes all three counters
and their values; it must not be used after numbering starts without preserving them.

Migration `007_add_cycle_financial_settings.js` stores financial terms on each
cycle, so different cycles can use different terms:

| Column | Meaning |
| --- | --- |
| `interest_rate` | Nonnegative percentage per period, with up to 6 decimal places; `2.5` means 2.5%, not 250%. |
| `interest_period` | `DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`. |
| `interest_method` | `SIMPLE` for outstanding principal only; `COMPOUND` for outstanding principal plus unpaid interest. |
| `cost_per_share` | Positive monetary price of one share, with 2 decimal places. |

All four fields default to null, leaving existing cycles unconfigured. The three
interest fields must be either all set or all null; zero interest is explicitly
represented by a rate of `0` with a period and method. Share price can be configured
independently. For example, `interest_rate: 2.5`, `interest_period: 'MONTHLY'`,
`interest_method: 'COMPOUND'`, and `cost_per_share: 100.00` specify 2.5% monthly
compound interest and a share price of 100 in the group's monetary unit.

This migration stores settings only; it does not calculate interest, schedule
accruals, or generate accounting entries. Lending and share-purchase code must
require the relevant settings before use. Before implementing those operations,
define payment allocation, partial-period calculations, and rounding, and preserve
the terms applied to each loan or share purchase so later setting changes do not
rewrite historical amounts. Writers must maintain the cycle's `updated_at`.

### Group roles

Migration `008_add_user_group_roles.js` adds a required `users.role` scoped to
the user's `group_id`. Allowed roles and intended permissions are:

| Role | Intended permissions |
| --- | --- |
| `OWNER` | Full group access, assign admins, transfer ownership, manage settings. |
| `ADMIN` | Manage users, cycles, cycle membership, and financial settings. |
| `TREASURER` | Record financial operations, manage accounts, view financial reports. |
| `MEMBER` | View their own shares, loans, payments, and balances; submit supported requests. |
| `AUDITOR` | Read-only access to group transactions, accounts, and reports. |

Existing users and ordinary inserts default to `MEMBER`. Assign existing group
owners explicitly after review; the migration does not infer ownership. New group
registration assigns its creator `OWNER` in the database trigger, independently
of client-supplied role metadata. Cycle membership remains separate.
The migration stores and validates roles. `POST /user` enforces owner/admin access;
role-management APIs are not implemented. Rolling it back removes all role assignments and
restores the previous registration behavior.

### Group users

Apply migration `010_scope_group_user_list.js` before deploying. The migration
account must be able to create roles; the runtime account must be able to
`SET ROLE comsca_group_reader` (membership is granted to the migration account).
The list queries run with this restricted role and a transaction-local group ID
resolved from `x-group-slug`. PostgreSQL RLS isolates users, cycles, and cycle
members even without application group filters. The role cannot read passwords
or Auth IDs. Existing authenticated OWNER/ADMIN authorization still applies.

`GET /api/v1/groups/users` lists users belonging to
the group selected by `x-group-slug`. Requires a bearer access token and an
`OWNER` or `ADMIN` database role in that group, as for user creation.

```http
GET /api/v1/groups/users
Authorization: Bearer <access_token>
x-group-slug: your-group
```

Returns `{ "success": true, "current_cycle_id": "7", "users": [...] }`.
Each user includes `id`, `group_id`, `first_name`, `family_name`, `username`,
`email`, `phone`, `address`, `role`, `created_at`, `updated_at`, and the boolean
`is_current_cycle_member`. Passwords and Auth IDs are excluded. Users without
login access are included. Results include all group users, ordered by family
name, first name, and ID.

The **current cycle is the sole non-closed cycle in the group** (`draft`,
`active`, or `distributing`). Membership in closed cycles does not count, even
when a closed cycle has a newer creation date. With no current cycle,
`current_cycle_id` is null and every membership flag is false. Query parameters cannot override the
group or cycle selection. Returns `400` for a missing group header, `401` for
missing/invalid authentication, `404` for an unknown group, and `403` for callers
without the required role in that group. Responses use `Cache-Control: no-store`.

### Current user

`GET /api/v1/users/me` returns the authenticated user's
application profile in the group selected by `x-group-slug`. Available to all
five group roles.

```http
GET /api/v1/users/me
Authorization: Bearer <access_token>
x-group-slug: your-group
```

Returns `200` with `{ "success": true, "user": { ... }, "group": { ... } }`.
The user includes `id`, `group_id`, `first_name`, `family_name`, `username`,
`email`, `phone`, `address`, `role`, `created_at`, and `updated_at`. The group
includes `id`, `name`, and `slug`. Passwords, Auth IDs, and session tokens are
excluded, and responses use `Cache-Control: no-store`.

The verified bearer token determines identity; query parameters cannot select
another user. Roles are read from the database. Returns `400` for a missing group
header, `401` for missing or invalid authentication, `404` for an unknown group,
and `403` if the caller has no linked profile in the selected group. Provider
failures return `429`, `502`, or `503` as appropriate.

`GET /api/v1/me/transactions` returns all transaction entries associated with
the authenticated user in the selected group's current active or distributing
cycle, ordered by transaction time oldest first. If the group has no active or
distributing cycle, `data` is an empty array. The response is
`{ "success": true, "data": [...] }`; each entry includes its IDs, resolved
`user_id`, cycle, type, exact decimal-string amount, description, and timestamps.
Each entry also includes `transaction_occurred_at` from its parent transaction.
For legacy entries without an entry-level `user_id` or `cycle_id`, ownership and
cycle fall back to the parent transaction. The endpoint requires migrations through
`027_add_contribution_member_entries.js`. The verified bearer token determines
the user; query parameters cannot change user or group scope. A missing linked
profile returns 403; missing group header, authentication, and unknown group
use the usual 400, 401, and 404 responses. Authenticated responses use
`Cache-Control: no-store`; group-resolution errors may be returned before
authentication.

### Update your profile

`PUT /api/v1/users/me` updates the authenticated user's profile in the selected
group. All group roles can use it. Use the same Bearer token and `x-group-slug`
headers as GET, plus `Content-Type: application/json`.

```json
{
  "first_name": "Ana",
  "family_name": "Cruz",
  "address": "123 Main Street"
}
```

Supply at least one of these fields; omitted fields remain unchanged. Names must
be nonempty strings of at most 255 characters. Address accepts a nonempty string
of at most 4000 characters or `null` to clear it. Strings are trimmed. Unsupported
fields, including phone, passwords, email, username, role and identity fields,
are rejected with `400` without applying any updates. Success returns `200` with
the same `{ "success": true, "user": { ... }, "group": { ... } }` shape as GET.
Authentication and group errors follow GET's status codes.

### Change your password

`PUT /api/v1/users/me/password` changes the authenticated user's Supabase Auth
password. Requires the same headers and a linked profile in the selected group.

```json
{
  "new_password": "your-new-strong-password",
  "repeat_new_password": "your-new-strong-password"
}
```

Both fields are required and must match exactly. Passwords are not trimmed and
must contain at least 8 characters and at most 72 UTF-8 bytes. Other fields are
rejected. The password is sent to Supabase using the caller's access token;
the application's legacy password column is not changed. Success returns `200`:

```json
{ "success": true, "message": "Password updated successfully" }
```

Validation, weak passwords and reuse of the current password return `400`.
Supabase reauthentication requirements return `403` with instructions to sign in
again. The endpoint respects the configured [Supabase password policy](https://supabase.com/docs/guides/auth/password-security);
projects requiring the current password receive `403` and must use a Supabase
password recovery flow. Authentication/group errors follow GET; provider throttling
and outages return `429`, `502`, or `503`. Both update endpoints use
`Cache-Control: no-store` and never return passwords or session tokens.

### Add a group member

`POST /api/v1/groups/users` (also `/api/v1/user`) creates a member profile in
the group identified by `x-group-slug`. Requires migration 008 and a Supabase
access token from the phone/password or OTP login flow. The legacy username login
does not issue an access token.

```http
POST /api/v1/groups/users
Authorization: Bearer <access_token>
x-group-slug: your-group
Content-Type: application/json

{
  "firstname": "Ana",
  "lastname": "Cruz",
  "username": "ana",
  "phone": "09171234567",
  "email": "ana@example.com",
  "address": "Main Street"
}
```

Only `firstname` and `lastname` are required. Names and username have a maximum
length of 255, email 320, phone 32, and address 4,000 characters. Philippine mobile
numbers normalize to `+639…`. Optional fields may be omitted or null.
New users always receive `MEMBER`; an optional `role` must be `MEMBER`.
Unsupported fields, including `group_id`, `auth_user_id`, and `password`, are rejected.

The bearer token is verified with Supabase Auth. The caller's linked database user
must belong to the selected group and currently have `OWNER` or `ADMIN`; token
metadata does not grant permissions. The role check and insert run in one database
transaction, locking the caller's row against concurrent role/group changes.

Returns `201` with `{ "success": true, "user": { ... } }`, including the new user's
ID, group, profile fields, role, and creation timestamp. Returns `400` for invalid
input or a missing group header, `401` for missing/invalid authentication, `403`
for insufficient group permissions, `404` for an unknown group, and `409` for a
duplicate username within the group. Authentication provider errors return `429`,
`502`, or `503` as appropriate.

This creates an application profile only. It does not create a Supabase login,
send an invitation or SMS, or add the member to a cycle. Use the account endpoint
below for login provisioning; cycle enrollment remains separate.

### Enable a member's login

`POST /api/v1/groups/users/:id/account` provisions
a phone/password login for an existing member. Requires `OWNER` or `ADMIN` in
the `x-group-slug` group; the target must belong to that same group.

```http
POST /api/v1/groups/users/20/account
Authorization: Bearer <admin_or_owner_access_token>
x-group-slug: your-group
Content-Type: application/json

{ "password": "initial-password" }
```

The password must contain at least 8 characters and at most 72 UTF-8 bytes, and
meet the project's Supabase password policy. Other body fields are rejected.
The member must already have a saved `+639…` phone number. The endpoint uses
Supabase's server-only [Admin createUser API](https://supabase.com/docs/reference/javascript/auth-admin-createuser)
with `phone_confirm: true`: no OTP or invitation is sent. The administrator is
responsible for confirming the member's phone. Login then uses the existing
`POST /api/v1/auth/login/password` endpoint with that phone and password.

Setup: apply migration `009_link_member_auth_accounts.js` and configure
`SUPABASE_SERVICE_ROLE_KEY` in the backend environment (and `.env.production`
for production deployment). This privileged key must never be supplied by the
browser. `SUPABASE_URL` and `DATABASE_URL` must refer to the same Supabase project.

The migration installs a deferred Auth trigger which reads server-controlled
app metadata, rechecks the actor's group role, and links `users.auth_user_id` in
the same database transaction that creates the Auth user. Missing, already-linked,
or changed targets cause Auth creation to roll back. No password is stored in
the application's `users` table, and the member's role stays unchanged. The
existing registration trigger remains responsible only for new-group signups.
Rollback removes the provisioning trigger without deleting existing accounts or links.

Returns `201` with `{ "success": true, "user": { "id": "20", "group_id": "1",
"phone": "+639171234567", "role": "MEMBER", "has_login": true,
"phone_verified": true } }`. Passwords, Auth IDs, and session tokens are excluded.
Returns `400` for invalid input/missing phone, `401` for invalid authentication,
`403` for insufficient group permissions, `404` for a target outside the group or
a missing target, and `409` for existing login access or a phone already in Auth.
Existing Auth accounts are never adopted or reset. Missing migration/configuration
returns `503`; provider errors return `429` or `502`.
If a response is lost after Auth commits, retrying returns `409` because the link
already exists; the original password remains in effect.

## AWS Lambda

Configure the Lambda handler as `src/handler.handler` and expose it through API Gateway or a Lambda Function URL.

### Production (Supabase)

Set `DATABASE_URL` in `.env.production` to the Supabase transaction pooler
connection string. Set `MIGRATION_DATABASE_URL` in the same file to the direct
or session pooler connection string for migrations.

```bash
npm run migrate:production
npm run deploy:production
```

These commands explicitly read `.env.production`. Deployment updates the existing
`prod` stage (`comsca-backend-prod-api`) in `ap-southeast-1`; the filename does not
change the stage name. The deployment requires Serverless Framework v3 and AWS
credentials. Environment files are excluded from the deployment archive.

Application tables have row level security enabled without public API policies.
The backend uses the database owner connection; browser clients cannot access
these tables through the Supabase Data API by default.

## Group-scoped login

`POST /api/v1/auth/login` takes the group slug from `x-group-slug` and credentials
from a JSON body:

```http
POST /api/v1/auth/login
Content-Type: application/json
x-group-slug: your-group

{"username":"your-username","password":"your-password"}
```

The `users.password` column must contain a bcrypt hash (use
`await require("bcryptjs").hash(password, 12)` when creating users). Plaintext
passwords are rejected. Usernames are case-sensitive and unique within each group.
Passwords are not trimmed and must be at most 72 UTF-8 bytes.

Apply migration `003_scope_login_to_group.js` before deploying this handler.
The migration account must be able to create roles and grant role membership;
the runtime database account must be able to `SET ROLE comsca_login`. By default
the migration grants this membership to the account running the migration.

The login lookup switches to the restricted `comsca_login` role inside a
transaction and sets a transaction-local group ID. Its RLS policy permits reading
only that group's users, including when the application omits the group filter.
Role and group context reset on commit or rollback for pooler compatibility.
The owner connection used elsewhere still bypasses RLS; this policy is scoped to
the login lookup and does not authorize other endpoints based on a header alone.

Success returns `success: true` and a user object with `id`, `group_id`,
`username`, `first_name`, and `family_name`. Invalid credentials return 401;
missing/invalid input returns 400; an unknown group returns 404. This endpoint
verifies credentials only; session/token issuance is not implemented yet.

Run `npm test` for request tests. To also run PostgreSQL RLS integration tests,
set `TEST_DATABASE_URL` to an **empty, disposable database** on a dedicated
PostgreSQL instance. The tests apply migrations, create fixtures and a database
role, and check cross-group access and pooled connection cleanup. Never point
this variable at production or a shared database.

## Phone registration and SMS hook

`POST /api/v1/user/register` accepts JSON without an `x-group-slug` header:

```json
{
  "firstname": "Ana",
  "lastname": "Cruz",
  "phone": "09171234567",
  "groupName": "Our Community",
  "slug": "our-community",
  "password": "your-strong-password"
}
```

| Input | Application database | Supabase Auth |
| --- | --- | --- |
| `firstname` | `users.first_name` | Registration metadata |
| `lastname` | `users.family_name` | Registration metadata |
| `phone` | `users.phone`, normalized to `+639…` | Phone identity |
| `groupName` | `groups.name` | Registration metadata |
| `slug` | `groups.slug`, trimmed/lowercase | Registration metadata |
| `password` | Not stored; `users.password` stays NULL | Password managed by Auth |
| Auth-generated UUID | `users.auth_user_id` | `auth.users.id` |
| Group-generated ID | `users.group_id` | Not used as an authorization claim |

`username` and `email` remain NULL for these registrations. Existing legacy users
retain their existing values. Philippine mobile numbers may use `09…`, `639…`,
or `+639…`; other formats are rejected. Names have a 255-character limit, slugs
are DNS labels of at most 63 characters, and passwords require at least 8
characters and at most 72 UTF-8 bytes. Supabase may enforce stronger passwords.

Registration creates a **new group**. It does not join an existing group.
An existing slug returns 409. The database unique constraint also prevents races.
Migration `004_supabase_registration.js` installs an insert trigger on
`auth.users` to create the group and profile inside the Auth transaction. A failed
insert rolls the records back together. The trigger validates metadata even for
direct Auth signups; subsequent metadata edits never change group membership.
It requires Supabase's `auth.users` table, including for local development.

On success the endpoint returns 201 with `success`, `verification_required`, and
a message. Keep phone confirmation enabled: users verify their OTP using the
endpoint below, which calls Supabase Auth with `type: "sms"`. The legacy bcrypt
login endpoint remains separate; new accounts authenticate through Supabase Auth.

### Supabase login and sessions

These JSON endpoints require no `x-group-slug` header and return
`Cache-Control: no-store`. Phone numbers use the same Philippine mobile number
normalization as registration (`09171234567` becomes `+639171234567`).

| POST endpoint | JSON body / header |
| --- | --- |
| `/api/v1/auth/login/password` | `{"phone":"09171234567","password":"your-password"}` |
| `/api/v1/auth/login/otp/request` | `{"phone":"09171234567"}` |
| `/api/v1/auth/login/otp/verify` | `{"phone":"09171234567","otp":"012345"}` |
| `/api/v1/auth/refresh` | `{"refresh_token":"your-refresh-token"}` |
| `/api/v1/auth/logout` | Header: `Authorization: Bearer <access_token>`; no body required |

Password login, OTP verification, and refresh return HTTP 200 with
`{"success":true,"user":{...},"group":{...},"session":{...}}`, using the same
profile and session fields as `/api/v1/user/verify`. Membership is resolved from
the Supabase-authenticated user ID. The frontend should replace its stored access
and refresh tokens with the returned `session.access_token` and
`session.refresh_token` after each successful refresh.

OTP requests use `create_user: false` so login does not register new accounts.
Successful requests return HTTP 200 with
`{"success":true,"message":"If an account exists for this phone number, a verification code has been sent"}`.
The existing Supabase SMS hook sends the code. Keep OTPs as strings to preserve
leading zeros.

Logout returns HTTP 200 with `{"success":true,"message":"Logged out successfully"}`.
It uses Supabase's `local` scope to revoke the current session's refresh tokens.
The frontend must clear its stored tokens after logout. Already issued access
tokens remain valid until expiry, as described in
[Supabase's sign-out documentation](https://supabase.com/docs/guides/auth/signout).

Failures return `{"success":false,"error":"..."}`: HTTP 400 for invalid input or
invalid/expired OTPs, 401 for invalid credentials or sessions, 403 for unconfirmed
phones or blocked accounts, 409 for missing application profiles/groups, 429 for
rate limits, 503 for missing Auth configuration, and 502 for upstream failures.
Expired OTPs return `"Invalid or expired verification code"`.

The legacy `/api/v1/auth/login` endpoint keeps its existing group-header and
bcrypt behavior. These new routes do not add access-token validation to other
application endpoints. They use the existing Supabase configuration and require
no migration.

### Check group slug availability

`GET /api/v1/groups/validate-slug?slug=my-group` requires no `x-group-slug` header.
Slugs are trimmed and lowercased using the registration rules.
Both availability results return HTTP 200:

```json
{"success":false,"message":"Group slug is already in use","group":{"id":1,"name":"COMSCA"}}
```

```json
{"success":true,"message":"Group slug is available"}
```

Missing, invalid, or reserved slugs return HTTP 400; database failures return
HTTP 503, both with `success: false` and a `message`. Results are not cached.
Availability does not reserve the slug; registration still checks for conflicts.

### Verify the phone OTP

`POST /api/v1/user/verify` accepts JSON without an `x-group-slug` header:

```json
{"phone":"09171234567","otp":"012345"}
```

Send the OTP as a string to preserve leading zeros. Phone normalization matches
registration. Supabase validates the code and confirms phone ownership. A 200
response contains `success: true`, the linked `user`, its `group`, and `session`
with `access_token`, `refresh_token`, `token_type`, `expires_in`, and `expires_at`
when supplied by Supabase. Responses use `Cache-Control: no-store`.

The profile lookup uses only the verified Supabase user ID. Caller-supplied IDs
and slugs do not select a profile. Missing or invalid input and invalid/expired
OTPs return 400, rate limits return 429, unlinked accounts return 409, missing
configuration returns 503, and upstream failures return 502. Failed verification
never returns session tokens. Supabase controls OTP expiry and reuse.

No new migration is needed for verification, but the registration migration must
already be applied. The existing backend endpoints still need token-validation
middleware before they can use this session for authorization.

### Configuration

Add these to `.env.production` (or `.env` for local use):

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
SUPABASE_SMS_HOOK_SECRET=v1,whsec_YOUR_HOOK_SIGNING_SECRET
```

The Auth project and `DATABASE_URL` must refer to the same Supabase project.
No service-role/admin key is needed. `deploy:production` passes these values to
Lambda. Obtain the public key from Supabase's project API settings and the hook
secret from Authentication → Hooks when configuring the HTTP Send SMS hook.

1. Apply migrations with `npm run migrate:production`.
2. Deploy with `npm run deploy:production`.
3. Enable Phone authentication and phone confirmation in Supabase.
4. Enable the **Send SMS** HTTP hook with URL
   `https://ryvggw5w5m.execute-api.ap-southeast-1.amazonaws.com/api/v1/hooks/sms`
   and the same signing secret as Lambda.

The hook verifies Standard Webhooks signatures and timestamps against the raw
request body. It does not require `x-group-slug`. From Supabase's `user.phone`
and `sms.otp` fields it sends an unauthenticated JSON POST to
`https://api.brevph.com/api/v1/cane/send`:

```json
{
  "recipient": "+639171234567",
  "message": "Your COMSCA verification code is 123456. Do not share this code."
}
```

The gateway call times out after 3 seconds to fit Supabase's 5-second HTTP hook
budget. HTTP 2xx from the gateway is treated as acceptance and returns `{}` with
200 to Supabase; non-2xx/network failures return a hook error. Delivery receipts
and deduplication of retries are not implemented. No OTPs or passwords are logged.
Tests stub Auth and the gateway; they do not create real accounts or send SMS.

Browser requests are allowed from HTTPS `comsca.com` and its immediate subdomains,
plus HTTP localhost development origins. Additional exact origins can be listed
in `CORS_ALLOWED_ORIGINS`, separated by commas. CORS preflights are handled before
application authentication and validation. Cookie credentials are not enabled.
Registration and verification also accept the frontend's ten-digit `9…` mobile
number and normalize it to `+639…`. Registration validation returns field-specific
messages in `errors`, with a readable summary in `error`.

All API endpoints use the `/api/v1` prefix. Unversioned URLs (including `/`) return
`404`; clients must use the versioned paths shown above.

### Charge contributions

`POST /api/v1/contributions/charge` requires `Authorization: Bearer <token>`,
`x-group-slug`, and `Content-Type: application/json`. The caller must be an
OWNER, ADMIN, or TREASURER in the selected group.

```json
{
  "amount": "25.50",
  "debit": "101",
  "credit": "102",
  "description": "September contributions"
}
```

`amount` is a positive **per-member** amount with at most two decimal places.
Use decimal strings for large amounts. `debit` selects Contributions Receivable
(1400, ASSET), and `credit` selects Contribution Income (4400, INCOME). Accounts
must belong to the selected group and, when cycle-scoped, its current cycle.
Accounts 1400 and 4400 must already exist. Migration 026 changes future account
seeding, so already-active cycles may lack them. An operator can provision the
current defaults for an older cycle with the existing PostgreSQL function
`SELECT public.seed_cycle_accounts(group_id, cycle_id)`. Its compatibility checks
reject conflicting reserved account definitions. The charge endpoint does not
backfill accounts.

`description` is optional (up to 4000 characters); other fields are rejected.
The current cycle is the newest non-closed cycle, ordered by creation time and ID.

A successful response is HTTP 201 with `{ "success": true, "transaction": {...},
"entries": [...], "account_entries": [...] }`. Three enrolled members at 25.50
produce one CONTRIBUTION transaction totaling 76.50, three CONTRIBUTION entries
with `user_id`, `cycle_id`, and amount 25.50, and six account postings. Each member
entry has a +25.50 debit and -25.50 credit; account totals equal the full charge.
All records commit atomically. Repeating a successful request creates a new charge.

Invalid input or numeric(18,2) overflow returns 400; insufficient role returns 403;
accounts absent from the selected group return 404. Missing current cycle, an
empty roster, or a concurrent integrity conflict returns 409 with no partial writes.

### Charge penalties

`POST /api/v1/penalties/charge` requires `Authorization: Bearer <token>`,
`x-group-slug`, and `Content-Type: application/json`. The caller must be an
OWNER, ADMIN, or TREASURER in the selected group.

```json
{
  "amount": "10.00",
  "debit": "101",
  "credit": "102"
}
```

The account values are illustrative database IDs, not account codes. `amount`
is a positive per-member amount with at most two decimal places and must fit
`numeric(18,2)`; the aggregate for the full roster must also fit. The charge
applies to every member enrolled in the current cycle. `debit` must be the ID
of Penalties Receivable (code 1300, ASSET), and `credit` must be the ID of
Penalty Income (code 4100, INCOME). Both accounts must belong to the selected
group and, if cycle-scoped, to the current cycle. Accounts must already exist.

`description` is optional and limited to 4000 characters; other fields are
rejected. The current cycle is the newest non-closed cycle, ordered by creation
time and ID. For a draft cycle, use group-scoped accounts; cycle-specific
default accounts are seeded when the cycle becomes active or distributing.
A successful response is HTTP 201 with the transaction, member entries, and
account postings. The transaction type is `PENALTY`; each enrolled member
receives one `CHARGE_PENALTY` entry with their user and cycle IDs, plus a
positive debit and matching negative credit. The transaction amount is the
per-member amount multiplied by the enrolled roster. All records commit
atomically; repeating a successful request creates a new charge.

Invalid input or aggregate overflow returns 400; insufficient role returns
403; accounts absent from the selected group return 404. Missing current cycle,
an empty roster, or a concurrent integrity conflict returns 409 with no partial
writes.
