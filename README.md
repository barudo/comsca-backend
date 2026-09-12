# Comsca Backend

Express API configured for AWS Lambda.

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

### Check group slug availability

`GET /groups/validate-slug?slug=my-group` (also available at
`/api/v1/groups/validate-slug`) requires no `x-group-slug` header.
Slugs are trimmed and lowercased using the registration rules.
Both availability results return HTTP 200:

```json
{"success":false,"message":"Group slug is already in use"}
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
