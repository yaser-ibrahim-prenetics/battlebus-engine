# GCP deployment

Battle Bus is deployed as an internet-reachable Cloud Run service in
`battle-bus-509406`. Public reachability is required for Shopify, warehouse
webhooks, and Inngest's `serve()` callback model. Authentication is enforced by
the application: Inngest requests use its signing key, provider webhooks use
their provider signatures/secrets, and internal/operator endpoints use
`BATTLE_BUS_API_KEY`.
GitHub Actions uses Workload Identity Federation (OIDC); the repository must not
contain a Google Cloud service-account key.

## Deployment targets

- GitHub repository: `yaser-ibrahim-prenetics/battlebus-engine`
- Cloud Run service: `battle-bus`
- Region: `asia-east1`
- Artifact Registry repository: `battle-bus`
- Runtime identity: `battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com`
- Deployment identity: `battle-bus-deployer@battle-bus-509406.iam.gserviceaccount.com`
- GitHub environment: `gcp-production`

Set the repository Actions variable `ENABLE_GCP_DEPLOY=true` only after the GCP
OIDC and IAM bindings have been verified. The deploy job references the
`gcp-production` environment, but the gate must be repository-scoped because
GitHub evaluates the job-level condition before attaching that environment.
Until then, pushes run all quality gates but skip deployment.

Run `scripts/bootstrap-gcp.sh` from an authenticated operator workstation to
create or reconcile the Artifact Registry repository, four service accounts,
the repository-restricted GitHub OIDC provider, and deployer IAM bindings. The
script does not create secrets or enable deployment.

Every pull request runs lint, tests, the high-severity production dependency
audit, and the production build. A push to `main` deploys only after all four
gates pass. Production-changing feature flags are initially forced off.

## Secrets

Store server credentials in Secret Manager and grant the runtime service
account access to only the secrets it needs. Do not move `VERCEL_*` variables,
Vercel deploy hooks, local `.env` files, or service-account JSON keys into
GitHub.

Before deployment is enabled, the existing Cloud Run service must expose these
Secret Manager-backed environment names:

- `INNGEST_SIGNING_KEY`
- `INNGEST_EVENT_KEY`
- `BATTLE_BUS_API_KEY`
- `SHOPIFY_TEST_WEBHOOK_SECRET` while the deployment remains in test/dry-run mode

The deployment workflow currently sets safe operational feature flags. Add
Secret Manager bindings to the `gcloud run deploy` command only after the
secret names and least-privilege IAM bindings have been reviewed.

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
