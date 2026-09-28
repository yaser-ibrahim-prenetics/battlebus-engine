# Release 1: database foundation

## Brief

Release 1 establishes Battle Bus as the owner of the shared Battle Platform
PostgreSQL schema. It introduces a deterministic, paired `golang-migrate`
workflow while keeping the application rollout additive: no legacy order
columns or business data are removed.

The release is safe to merge before a Supabase project is connected. CI tests
the complete migration lifecycle on disposable PostgreSQL, while remote
migration execution remains disabled until the explicit
`ENABLE_DATABASE_MIGRATIONS=true` repository gate is enabled.

## Delivered

- Four ordered up/down migration pairs under `db/migrations` covering:
  - Orders, order lines, inventory, SKU mappings, locations, products, and stock.
  - Durable webhook inbox, flow logs, mission runs, and audit history.
  - Battle Hub users, roles, permissions, workspaces, and secure views.
  - Search indexes and reporting RPCs.
- Missing `locations.country_data_area_mapping` and reliability tables required
  by current Battle Bus code.
- Row Level Security on every application table.
- Removal of anonymous table writes from the canonical schema.
- Permission-aware authenticated policies and service-role-only backend access.
- Migration creation, validation, execution, version, rollback, and disposable
  database test commands.
- Idempotent initial-superadmin and Battle Hub workspace membership bootstrap.
- CI `up -> assertions -> down-all -> up -> assertions` verification on
  PostgreSQL 16.
- Optional, guarded GCP migration execution through Secret Manager.
- Isolated `battle-bus-migrate` Cloud Run Job using a dedicated identity,
  immutable migration image, and pinned numeric database-secret version.
- Contract-migration evidence validation that blocks obsolete schema removal
  until usage, dependencies, rollback revisions, observability, and recovery
  readiness have been confirmed.
- Retirement notice for the old `supabase/migrations` location so there is only
  one migration history.

## Verification results

- Migration filename/pair validation: passed.
- PostgreSQL 16 first `up`: passed.
- Schema, RLS, no-anonymous-write, and permission assertions: passed.
- Full `down-all`: passed.
- Second `up` and assertion pass: passed.
- ESLint quality gate: passed with the repository's existing warning allowance.
- Vitest: 37 files passed, 5 skipped; 440 tests passed, 6 skipped.
- Next.js production build: passed.
- Production dependency audit: zero vulnerabilities.

## Not activated yet

No cloud database was created or modified by this release. Before activation:

1. Create or select the non-production Supabase project and region.
2. Add its migration connection URL to the GCP secret
   `battle-platform-database-url`.
3. Set `DATABASE_URL_SECRET_VERSION` to the numeric enabled secret version.
4. Configure Battle Bus and Battle Hub Supabase runtime credentials.
5. Bootstrap the dedicated Cloud Run migration job with an immutable image.
6. Apply and validate the migrations in staging.
7. Pre-register the initial Battle Hub superadmin and workspace membership.
8. Enable `ENABLE_DATABASE_MIGRATIONS=true` only after staging acceptance.

Production database rollback remains manual. Subsequent changes must use
expand/deploy/contract sequencing, and applied migration files must never be
edited in place. Obsolete schema removal additionally requires the checked
evidence record described in `db/contracts/README.md`.
