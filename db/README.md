# Battle Platform database migrations

Battle Bus owns the shared PostgreSQL schema used by Battle Bus and Battle Hub.
Migrations use [golang-migrate](https://github.com/golang-migrate/migrate) and
are the only supported way to change a deployed database schema.

## Release 1 scope

Release 1 establishes an additive schema. It creates the current operational,
reliability, audit, and Battle Hub access objects without dropping legacy order
columns. Cleanup and column removal must be delivered later as explicit
contract migrations after all application revisions have stopped using them.

The migrations also replace legacy anonymous-write policies with policies for
registered, authenticated users. Battle Bus writes with the Supabase service
role. A first Battle Hub administrator must be pre-registered through a
service-role-controlled process before interactive sign-in can succeed.

## File convention

Every logical change has a paired migration:

```text
000001_reason_for_change.up.sql
000001_reason_for_change.down.sql
```

Create the next pair with:

```bash
npm run db:create -- reason_for_change
```

Never edit a migration after it has been applied to a shared environment.
Create a new migration instead.

## Prerequisites

- PostgreSQL 15 or newer, or a current Supabase PostgreSQL project.
- `golang-migrate` v4.20.1.
- `psql` for local migration integration tests.
- A direct or session-mode PostgreSQL connection string with TLS. Do not use a
  transaction-mode pooler for DDL migrations.

The application uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Migrations
use a separate privileged `DATABASE_URL`; the latter must never be exposed to
the browser or stored in a committed environment file.

## Commands

```bash
npm run db:validate
DATABASE_URL='postgresql://...' npm run db:version
DATABASE_URL='postgresql://...' npm run db:up
DATABASE_URL='postgresql://...' npm run db:down
MIGRATION_TEST_DATABASE_URL='postgresql://...' npm run db:test
BATTLE_HUB_ADMIN_EMAIL='admin@example.com' DATABASE_URL='postgresql://...' npm run db:bootstrap-admin
```

`db:down` rolls back exactly one version. The full down/up cycle is restricted
to `MIGRATION_TEST_DATABASE_URL` by the test script. Production automation only
runs `up` migrations and never performs an automatic schema rollback.

## CI and deployment

Pull requests validate migration names and run `up -> assertions -> down-all ->
up -> assertions` against disposable PostgreSQL.

Production migration execution is guarded by the GitHub repository variable
`ENABLE_DATABASE_MIGRATIONS=true`. Before enabling it:

1. Create a development or staging Supabase project in the nearest supported
   region to the Cloud Run deployment.
2. Add its privileged session/direct connection string as the latest version
   of the GCP Secret Manager secret `battle-platform-database-url`.
3. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on Battle Bus Cloud
   Run and the matching Supabase variables on Battle Hub.
4. Pre-register the initial Battle Hub superadmin with `db:bootstrap-admin`
   from a trusted operator environment.
5. Run the pipeline in staging and verify order, location, flow-log, and webhook
   inbox reads/writes before enabling the production gate.

Application rollback and schema rollback are intentionally separate. All
production schema changes must follow expand/deploy/contract sequencing.
