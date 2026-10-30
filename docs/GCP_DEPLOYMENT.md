# GCP deployment

Battle Bus is deployed as an internet-reachable Cloud Run service in
`battle-bus-509406`. Public reachability is required for Shopify, warehouse
webhooks, and Inngest's `serve()` callback model. Authentication is enforced by
the application: Inngest requests use its signing key, provider webhooks use
their provider signatures/secrets, general internal endpoints use
`BATTLE_BUS_API_KEY`, and the restricted OOS operator endpoint uses the separate
`BATTLE_BUS_OPERATIONS_API_KEY` principal.
GitHub Actions uses Workload Identity Federation (OIDC); the repository must not
contain a Google Cloud service-account key.

## Deployment targets

- GitHub repository: `yaser-ibrahim-prenetics/battlebus-engine`
- Cloud Run service: `battle-bus`
- Cloud Run migration job: `battle-bus-migrate`
- Cloud SQL PostgreSQL 16 instance: `battle-platform-staging-pg16`
- Region: `asia-east1`
- Artifact Registry repository: `battle-bus`
- Runtime identity: `battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com`
- Migration identity: `battle-bus-migrator@battle-bus-509406.iam.gserviceaccount.com`
- Deployment identity: `battle-bus-deployer@battle-bus-509406.iam.gserviceaccount.com`
- GitHub environment: `gcp-production`

Set the repository Actions variable `ENABLE_GCP_DEPLOY=true` only after the GCP
OIDC and IAM bindings have been verified. The deploy job references the
`gcp-production` environment, but the gate must be repository-scoped because
GitHub evaluates the job-level condition before attaching that environment.
Until then, pushes run all quality gates but skip deployment.

Run `scripts/bootstrap-gcp.sh` from an authenticated operator workstation to
create or reconcile the Artifact Registry repository, five service accounts,
the repository-restricted GitHub OIDC provider, deployer IAM bindings, and the
empty `battle-platform-database-url` Secret Manager secret. The script never
adds a database credential value or enables deployment. The deployer can act as
the migration identity but cannot read the privileged database URL.

Battle Bus application revisions connect with passwordless Cloud SQL IAM
database authentication. The runtime does not receive the privileged migration
URL or any database password. Before applying migration `000005`, enable the
`cloudsql.iam_authentication=on` database flag without removing existing flags,
then run:

```bash
./scripts/bootstrap-runtime-database.sh
```

The script creates the Cloud SQL IAM database user for
`battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com` and grants the
runtime identity instance-scoped `roles/cloudsql.client` and
`roles/cloudsql.instanceUser`. Migration `000005` then grants that database
user membership in the NOLOGIN `battle_bus_runtime` group role. The group
inherits the existing `service_role` grants and RLS policy coverage.

Every pull request runs lint, tests, the high-severity production dependency
audit, database migration validation/integration tests, and the production
build. A push to `main` deploys only after all five gates pass.

## Secrets

The canonical credential inventory is
`config/gcp-secret-env-names.txt`. Run
`./scripts/migrate-cloud-run-secrets.sh` from an authenticated operator
workstation to convert existing plaintext Cloud Run credentials into Secret
Manager references through a verified no-traffic revision. See
`docs/SECRET_MANAGEMENT.md` for rotation and history-remediation guidance.
Secret names that cannot be safely derived, including the dedicated operations
credential, are pinned to reviewed numeric versions in
`config/gcp-secret-bindings.txt`; both the migration script and deployment
workflow consume that same mapping.

Store server credentials in Secret Manager and grant the runtime service
account access to only the secrets it needs. Do not move `VERCEL_*` variables,
Vercel deploy hooks, local `.env` files, or service-account JSON keys into
GitHub.

Before deployment is enabled, the existing Cloud Run service must expose these
Secret Manager-backed environment names:

- `INNGEST_SIGNING_KEY`
- `INNGEST_EVENT_KEY`
- `BATTLE_BUS_API_KEY`
- `BATTLE_BUS_OPERATIONS_API_KEY` (a distinct value stored in `battle-bus-operations-api-key`)
- `SHOPIFY_TEST_WEBHOOK_SECRET` while the deployment remains in test/dry-run mode

Release 1 database activation additionally requires:

- A Cloud SQL for PostgreSQL 16 instance in `asia-east1`.
- A privileged Cloud SQL Unix-socket PostgreSQL URL stored as an enabled
  version of `battle-platform-database-url`. Only the migration job identity can
  read this secret.
- `roles/cloudsql.client` on the dedicated migration identity.
- Cloud SQL IAM database authentication enabled and
  `scripts/bootstrap-runtime-database.sh` completed for the runtime identity.
- GitHub repository variable `DATABASE_URL_SECRET_VERSION` set to that numeric
  Secret Manager version. Do not use `latest` for production migrations.
- GitHub repository variable `ENABLE_DATABASE_MIGRATIONS=true` after staging
  validation. Until enabled, the workflow tests migrations but does not touch a
  remote database.

Every main deployment builds and pushes a small immutable migration image from
the same commit as the application. Before enabling migrations for the first
time, bootstrap the job with an already-pushed image:

```bash
MIGRATION_IMAGE_URI="asia-east1-docker.pkg.dev/battle-bus-509406/battle-bus/battle-bus-migrations:FULL_GIT_SHA" \
MIGRATION_RELEASE_SHA="FULL_GIT_SHA" \
DATABASE_URL_SECRET_VERSION="1" \
CLOUD_SQL_INSTANCE="battle-bus-509406:asia-east1:battle-platform-staging-pg16" \
./scripts/bootstrap-migration-job.sh
```

The bootstrap attaches the Cloud SQL instance and configures one task, no
automatic retries, a 15-minute timeout, the dedicated migration identity, and a
numeric Secret Manager version. It does not execute the job. The deployment
workflow updates and executes the job only when
`ENABLE_DATABASE_MIGRATIONS=true`, waits for success, and creates the new
application revision only afterward. Main deployments are serialized because a
Cloud Run Job can continue even if its GitHub runner disconnects.

Production runs only `up` migrations and never performs an automatic database
rollback. See `db/README.md` for the expand/deploy/contract policy,
obsolete-schema evidence gate, and first-administrator bootstrap requirement.

The deployment workflow currently sets safe operational feature flags. Add
new secret names to the canonical inventory and run the migration script before
enabling code paths that consume them.

Application revisions receive only these non-secret database settings:

- `CLOUD_SQL_INSTANCE_CONNECTION_NAME=battle-bus-509406:asia-east1:battle-platform-staging-pg16`
- `DB_NAME=battle_platform`
- `DB_USER=battle-bus-runtime@battle-bus-509406.iam`
- `DB_MAX_CONNECTIONS=5`

Before enabling the durable pending-action queue, provision the Battle Hub IAM
database user and apply the safe read-only active-action projection:

```bash
./scripts/bootstrap-hub-database.sh
```

Keep the repository variable `PENDING_ACTIONS_DURABLE_QUEUE_ENABLED=false` for
the first deployment containing migrations `000040` through `000046`. After the
old drain revision no longer receives traffic, verify Battle Hub readiness can
read `battle_hub_pending_lifecycle_actions`, and verify the owner-only
`requeue_pending_lifecycle_action(uuid,text)` function and
`pending_lifecycle_action_rollback_status()` gate and
`pending_lifecycle_action_resolutions` audit table exist but are inaccessible to
both runtime roles. Then set it to `true` and redeploy. Keep
`PENDING_ACTIONS_LEGACY_PROJECTION_ENABLED=true` through the rollback window.

Keep `OOS_TARGETED_DRAIN_ENABLED=false` for the first deployment containing
migration `000049`. Verify `battle_hub_oos_recovery` is readable by the Hub role,
run an authenticated dry drain for representative GPS and D365 keys, and confirm
the OOS queue metrics remain healthy. Enable the repository variable only after
the candidate revision and migration job have passed those checks. Disabling the
flag returns new orders to the legacy backorder path without removing parked data.

Keep `PROVIDER_CAPACITY_ENABLED=false` for the first deployment containing
migration `000052`. Verify `provider_capacity_leases` contains 100 free slots for
each provider and that the operations health response reports zero active and
expired leases. Enable the repository variable only after a dry-run candidate is
healthy, using the conservative per-provider defaults. Disabling the flag removes
the admission wait immediately without deleting or invalidating any in-flight
provider work; outstanding leases expire automatically.

The Node.js Cloud SQL connector obtains short-lived IAM credentials from the
Cloud Run service account. `DATABASE_URL` remains reserved for local tooling
and the isolated migration job.

## Slack notifications

Every Slack notification has a stable id built with `slackNotificationId(event.id, purpose, ...parts)`,
for example `01JB…:backorder-resolved:2`. Retries and replays of the same Inngest event produce the
same id. Parts distinguish notifications that one event legitimately sends more than once (per retry
attempt, per fulfillment, per GPS batch).

`SLACK_TRANSPORT` selects how notifications are delivered:

- `webhook` (default): posts directly to the `SLACK_*_CHANNEL` webhooks, unchanged from before.
  The id is not used.
- `kafka`: publishes a structured event to `SLACK_NOTIFICATION_TOPIC`
  (default `battle-bus.slack-notification`). `slack-notification-service` consumes it and posts each
  id at most once, so a retried step or a replayed run never posts twice.

Kafka transport configuration (no secrets; authentication is keyless as the runtime service account):

- `SLACK_TRANSPORT=kafka`
- `KAFKA_BOOTSTRAP_SERVERS=bootstrap.<cluster>.asia-east1.managedkafka.battle-bus-509406.cloud.goog:9092`
- `KAFKA_SASL_MECHANISM=google-oauthbearer` (TLS + SASL OAUTHBEARER for Google Cloud Managed
  Service for Apache Kafka)

Prerequisites before switching: the Managed Kafka cluster and topic exist, `battle-bus-runtime`
has `roles/managedkafka.client`, the Cloud Run service has Direct VPC egress to the cluster subnet,
and slack-notification-service is deployed and consuming. `validateConfig()` rejects
`SLACK_TRANSPORT=kafka` without brokers. Publishing failures are logged as `[Slack]` errors with
the notification id and never fail the workflow. Roll back by unsetting `SLACK_TRANSPORT`.

Once the Kafka transport is live, the `SLACK_*_CHANNEL` secrets can be removed from this service.
slack-notification-service mounts the same Secret Manager secrets.

## Inngest

Inngest remains the durable workflow control plane. Each successful deployment
sets `INNGEST_SERVE_ORIGIN` to the stable Cloud Run service URL, verifies that
the SDK sees both production keys, and sends a `PUT` to `/api/inngest` to sync
the deployed function definitions. Inngest signs invocation requests and the
SDK rejects invalid or replayed signatures.

Cloud Run IAM cannot grant anonymous access by URL path, so the service is
public at the transport layer. Every mutation, debug, configuration, and test
route must remain fail-closed behind application authentication. Adding a new
public route therefore requires an authentication test before deployment.

## Vercel retirement

The repository no longer contains the Vercel environment-management endpoint
or Vercel environment upload script. Retire the old Vercel project only after:

1. Cloud Run is healthy and the Inngest endpoint is connected.
2. Shopify and warehouse webhook destinations point to Cloud Run through the
   approved authenticated ingress.
3. Dry-run processing has been observed, followed by a controlled write-enabled
   canary.
4. Logs, retries, alerting, and rollback have been exercised.
5. The old Vercel project has received no required traffic for at least seven
   days.

First disconnect the Vercel Git integration and any deploy hooks. Delete the
Vercel project only after the observation window and a rollback decision.
