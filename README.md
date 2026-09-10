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
