# Comsca backend context

This is an existing Express API for group-based community savings operations.
Use the implemented code and migrations as the source of truth; this document
is an orientation, not a completed BMAD planning artifact.

## Stack and layout

- CommonJS JavaScript, Express 5, Knex, PostgreSQL, and Supabase Auth.
- `src/app.js` wires application middleware and the route registry; `src/server.js` runs locally.
- `src/handler.js` adapts Express to AWS Lambda via `serverless-http`.
- `src/routes/index.js` explicitly registers all HTTP routes, aliases, and their middleware.
- `src/handlers/` contains request handler classes; bind instance methods when registering routes.
- `migrations/` contains ordered schema and security changes.
- `test/` uses Node's built-in test runner and includes request and optional
  PostgreSQL integration tests.
- `serverless.yml` targets Node.js 20 on AWS Lambda in ap-southeast-1.

## Group isolation and authentication

- Group-scoped routes resolve `x-group-slug` through `src/middleware/group-slug.js`.
- The header selects a group; it does not authenticate the caller.
- Protected routes verify the bearer token, then check the caller's database
  profile and role within the selected group.
- Public registration, slug validation, and Auth routes have distinct middleware
  placement. Preserve that ordering when introducing routes.
- The owner database connection bypasses RLS. The login and group-user-list
  queries switch to restricted roles with transaction-local group context.
- `GET /api/v1/groups/users` requires OWNER or ADMIN, return only
  the selected group's users, and include current-cycle membership information.
- Cycle lifecycle is draft -> active -> distributing -> closed. Migration 012
  allows only one non-closed cycle per group; this is the current cycle even if
  a historical row has a newer creation date. Creation starts in draft, financial
  edits are draft-only, and closed cycles cannot be updated through the API.
- Never return password hashes or privileged Auth credentials in API responses.

## Development and verification

- `npm start`: local server. `npm run dev`: server with reload.
- `npm test`: request/unit tests; some tests bind local HTTP ports.
- PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to an empty,
  disposable database on a dedicated instance. They create schemas and roles.
- `npm run migrate:latest`: apply migrations to the configured database.
- Keep database changes in new migrations with appropriate rollback support.
- Use injected database/services in tests, as supported by `createApp`.
- Read `README.md` for endpoint contracts and production procedures. Environment
  values are private; `.env.example` documents the available settings.

## BMAD workspace

- Stable installed release: 6.12.0, core and BMM modules, Codex integration.
- Skills: `.agents/skills/`; shared runtime and config: `_bmad/`.
- Project knowledge: `docs/`.
- Planning: `_bmad-output/planning-artifacts/`.
- Implementation: `_bmad-output/implementation-artifacts/`.
- Durable team overrides: `_bmad/custom/config.toml`.
- Personal preferences: `_bmad/config.user.toml` or
  `_bmad/custom/config.user.toml` (gitignored).
