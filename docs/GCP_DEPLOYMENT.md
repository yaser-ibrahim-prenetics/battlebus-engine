# GCP deployment

Battle Bus is deployed as a private Cloud Run service in `battle-bus-509406`.
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

Set the GitHub environment variable `ENABLE_GCP_DEPLOY=true` only after the GCP
OIDC and IAM bindings have been verified. Until then, pushes run all quality
gates but skip deployment.

Every pull request runs lint, tests, the high-severity production dependency
audit, and the production build. A push to `main` deploys only after all four
gates pass. Production-changing feature flags are initially forced off.

## Secrets

Store server credentials in Secret Manager and grant the runtime service
account access to only the secrets it needs. Do not move `VERCEL_*` variables,
Vercel deploy hooks, local `.env` files, or service-account JSON keys into
GitHub.

The deployment workflow currently sets safe operational feature flags. Add
Secret Manager bindings to the `gcloud run deploy` command only after the
secret names and least-privilege IAM bindings have been reviewed.

## Inngest

Inngest remains the durable workflow control plane. Configure its production
app URL to the Cloud Run `/api/inngest` endpoint. Because the Cloud Run service
is private, use a supported authenticated ingress design before switching
production traffic; do not make the whole service public just to connect
Inngest.

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
