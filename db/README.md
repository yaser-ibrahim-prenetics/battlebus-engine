# Battle Platform database migrations

Battle Bus owns the shared PostgreSQL schema used by Battle Bus and Battle Hub.
Migrations use [golang-migrate](https://github.com/golang-migrate/migrate) and
are the only supported way to change a deployed database schema.

Battle Bus runtime access is passwordless. Provision the Cloud SQL IAM database
user with `scripts/bootstrap-runtime-database.sh` before applying migration
`000005`; that migration binds the IAM user to the NOLOGIN
`battle_bus_runtime` group role. The application never uses the privileged
`DATABASE_URL` migration secret.

Battle Hub also uses passwordless IAM authentication for server-side reads.
Provision it with `scripts/bootstrap-hub-database.sh` before applying migration
`000008`. Migration `000007` creates the NOLOGIN `battle_hub_runtime` role and
its read policy; migration `000008` binds the Hub IAM database user to that
role. The role is limited to the durable lifecycle-action queue in this release.

Each database schema has exactly one owning repository. Future services keep
their own migrations beside their application code. Shared pipeline tooling may
execute those migrations, but it must not own or copy service-specific SQL. If
multiple independently released services eventually need to change this shared
schema, move schema ownership to a dedicated Battle Platform schema repository
rather than a generic deployment repository.

## Release 1 scope

Release 1 establishes an additive schema. It creates the current operational,
reliability, audit, and Battle Hub access objects without dropping legacy order
columns. Cleanup and column removal must be delivered later as explicit
contract migrations after all application revisions have stopped using them.

The migrations also replace legacy anonymous-write policies with policies for
registered, authenticated users. On Cloud SQL the `anon`, `authenticated`, and
`service_role` names are NOLOGIN PostgreSQL group roles retained for schema and
RLS compatibility. Concrete Cloud Run identities receive only the group-role
membership they need. A first Battle Hub administrator must be pre-registered
through a service-role-controlled process before interactive sign-in can
succeed.

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

## Removing obsolete schema

Use expand/deploy/contract sequencing. A table, column, constraint, view,
function, trigger, policy, index, or other schema object may be removed only
after it is proven unused by every active and rollback-capable application
revision, Battle Hub and other consumers, reports, scheduled jobs, integrations,
and database dependencies.

Every destructive up migration must:

1. Include `-- migrate:contract`.
2. Include a checked evidence file at
   `db/contracts/000001_reason_for_change.md`.
3. Record the query-telemetry observation window, rollback-window end, schema
   owner, approval date, dependency check, and backup/PITR confirmation.
4. Be delivered separately from the application change that stops using the
   schema object.

`npm run db:validate` fails closed when the marker or evidence is incomplete.
See `db/contracts/README.md` for the required template. Production automation
never runs destructive down migrations.

## Prerequisites

- PostgreSQL 15 or newer. Cloud deployments use Cloud SQL PostgreSQL 16.
- `golang-migrate` v4.20.1.
- `psql` for local migration integration tests.
- A direct or session-mode PostgreSQL connection string with TLS. Do not use a
  transaction-mode pooler for DDL migrations.

Migrations use a separate privileged `DATABASE_URL`; it must never be exposed
to the browser or stored in a committed environment file. On Cloud Run it uses
the instance's Unix socket and is injected from Secret Manager only into the
dedicated migration job.

## Commands

```bash
npm run db:validate
npm run db:validate:test
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

1. Create a development or staging Cloud SQL PostgreSQL 16 instance in the same
   region as the Cloud Run deployment.
2. Add its privileged Unix-socket connection string as a new version of the GCP
   Secret Manager secret `battle-platform-database-url`.
3. Set `DATABASE_URL_SECRET_VERSION` to that numeric enabled version; production
   migration jobs never bind `latest`.
4. Grant the dedicated migration identity `roles/cloudsql.client` and attach
   the instance to the migration job.
5. Run `scripts/bootstrap-gcp.sh`, then bootstrap the pre-pushed immutable
   migration image with `scripts/bootstrap-migration-job.sh`.
6. Run the pipeline to apply the migrations in staging.
7. Pre-register the initial Battle Hub superadmin with `db:bootstrap-admin`
   from a trusted operator environment.
8. Verify order, location, flow-log, and webhook
   inbox reads/writes before enabling the production gate.

Application rollback and schema rollback are intentionally separate. All
production schema changes must follow expand/deploy/contract sequencing. The
workflow builds a migration image from the same commit as the application and
runs it as the single-task `battle-bus-migrate` Cloud Run Job before deploying
the new application revision. The job identity, rather than the GitHub deployer,
has access to the privileged database URL.
