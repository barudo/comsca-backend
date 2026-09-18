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

The endpoint is available at `http://localhost:3000/`.

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

Migration `006_create_accounts_and_transaction_entries.js` adds group-owned
`accounts` (unique code per group, name, description, and type: `ASSET`,
`LIABILITY`, `EQUITY`, `INCOME`, or `EXPENSE`) and `transaction_entries`.
Each entry references a transaction and an account in the same group and has
exactly one positive `debit` or `credit`, with the other zero. Both amounts use
18 digits including 2 decimal places. Referenced accounts cannot be deleted.

Save a transaction and its entries together inside a Knex `db.transaction(...)`.
A deferred database constraint requires at least two entries with equal total
debits and credits at commit. Entry inserts, updates, and deletes also trigger
this check and update the parent transaction's `updated_at`. An entry's group
and transaction cannot be reassigned. Existing transactions are not backfilled;
they require balanced entries when next edited. Concurrent entry writes serialize
through their parent transaction; callers must handle database transaction retries.

For a `LOAN_PAYMENT` of 1,100 covering 1,000 principal and 100 interest, record:

| Account | Debit | Credit |
| --- | ---: | ---: |
| Cash | 1,100 | 0 |
| Loans Receivable | 0 | 1,000 |
| Interest Income | 0 | 100 |

If interest was previously recorded as a receivable, credit Interest Receivable
instead of recognizing the income again. Derive account balances from entries:
debits minus credits for assets and expenses, credits minus debits for liabilities,
equity, and income. No mutable balance column or default accounts are created.
Both new tables enable row level security without public API policies.

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

`GET /groups/users` (also `GET /api/v1/groups/users`) lists users belonging to
the group selected by `x-group-slug`. Requires a bearer access token and an
`OWNER` or `ADMIN` database role in that group, as for user creation.

```http
GET /groups/users
Authorization: Bearer <access_token>
x-group-slug: your-group
```

Returns `{ "success": true, "current_cycle_id": "7", "users": [...] }`.
Each user includes `id`, `group_id`, `first_name`, `family_name`, `username`,
`email`, `phone`, `address`, `role`, `created_at`, `updated_at`, and the boolean
`is_current_cycle_member`. Passwords and Auth IDs are excluded. Users without
login access are included. Results include all group users, ordered by family
name, first name, and ID.

Until an explicit cycle lifecycle is introduced, **current cycle means the most
recently created cycle in that group**, ordered by `created_at DESC, id DESC`.
Membership in older cycles does not count. With no cycle, `current_cycle_id` is
null and every membership flag is false. Query parameters cannot override the
group or cycle selection. Returns `400` for a missing group header, `401` for
missing/invalid authentication, `404` for an unknown group, and `403` for callers
without the required role in that group. Responses use `Cache-Control: no-store`.

### Current user

`GET /users/me` (also `GET /api/v1/users/me`) returns the authenticated user's
application profile in the group selected by `x-group-slug`. Available to all
five group roles.

```http
GET /users/me
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

### Add a group member

`POST /groups/users` (also `/api/v1/groups/users`, `/user`, and `/api/v1/user`) creates a member profile in
the group identified by `x-group-slug`. Requires migration 008 and a Supabase
access token from the phone/password or OTP login flow. The legacy username login
does not issue an access token.

```http
POST /groups/users
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

`POST /groups/users/:id/account` (also `/api/v1/groups/users/:id/account`) provisions
a phone/password login for an existing member. Requires `OWNER` or `ADMIN` in
the `x-group-slug` group; the target must belong to that same group.

```http
POST /groups/users/20/account
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

`GET /groups/validate-slug?slug=my-group` (also available at
`/api/v1/groups/validate-slug`) requires no `x-group-slug` header.
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
