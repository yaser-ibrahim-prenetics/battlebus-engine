# Battle Bus on Google Cloud Run

The initial Cloud Run deployment is intentionally private and uses dry-run feature flags. It keeps managed Inngest as the workflow orchestrator.

## Project defaults

- Project: `battle-bus-509406`
- Region: `asia-east1`
- Cloud Run service: `battle-bus`
- Artifact Registry repository: `battle-bus`
- Container port: `8080`
- Request timeout: `300s`
- Container concurrency: `20`
- Instances: `0-10`

## One-time project setup

```sh
gcloud config set project battle-bus-509406
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create battle-bus --repository-format=docker --location=asia-east1 --description="Battle Bus containers"
gcloud iam service-accounts create battle-bus-runtime --display-name="Battle Bus Cloud Run runtime"
```

## Build and deploy the private dry-run revision

Build and deployment are deliberately separate. Cloud Build can push the image, but it does not need Cloud Run Admin or Service Account User permissions.

```sh
IMAGE_TAG="manual-$(date +%Y%m%d-%H%M%S)"

gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions="_IMAGE_TAG=$IMAGE_TAG" \
  --project battle-bus-509406

gcloud run deploy battle-bus \
  --image="asia-east1-docker.pkg.dev/battle-bus-509406/battle-bus/battle-bus:$IMAGE_TAG" \
  --region=asia-east1 \
  --service-account=battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=300 \
  --concurrency=20 \
  --min-instances=0 \
  --max-instances=10 \
  --ingress=all \
  --no-allow-unauthenticated \
  --set-env-vars=DRY_RUN_MODE=true,SHOPIFY_STORE_MODE=test,ENABLE_DYNAMICS_SYNC=false,ENABLE_GPS_SYNC=false,ENABLE_STORD_SYNC=false,ENABLE_INVENTORY_RUNS=false,ENABLE_INVENTORY_SYNC=false,ENABLE_PRODUCT_INVENTORY_SYNC_CRON=false,ENABLE_RETURN_INVOICE_POSTING=false,ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK=false,ENABLE_GPS_FULFILLMENT_SIMULATION=false,ENABLE_LOOP_RETURNS=false,ENABLE_SLACK_RISK_CHECK=false,CS_PLATFORM_ENABLED=false \
  --project=battle-bus-509406
```

## Verify a private service

```sh
SERVICE_URL=$(gcloud run services describe battle-bus --region=asia-east1 --format='value(status.url)')
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$SERVICE_URL/api/health"
```

## Production activation

Do not make the whole service public. First configure Google Secret Manager references for Inngest, Shopify, D365, GPS, Supabase, Battle Hub and webhook secrets. Then expose only verified webhook and Inngest ingress through a dedicated public gateway or split the API and worker into separate Cloud Run services.

Resolve all production dependency advisories reported by `npm audit --omit=dev`, especially the critical Next.js and protobufjs advisories, and rebuild the image before exposing any endpoint publicly.

Remove dry-run flags only after the shadow/canary acceptance tests pass.

## GitHub Actions pipeline

`.github/workflows/ci-deploy-gcp.yml` runs for pull requests and pushes targeting `main`:

1. Install the exact `package-lock.json` dependency tree.
2. Run ESLint.
3. Run the Vitest suite.
4. Fail on critical production dependency advisories.
5. Build the Next.js application.
6. On `main` only, build and push an immutable commit-SHA container image.
7. Deploy a private, dry-run Cloud Run revision and verify that it becomes ready.

Authentication is keyless. GitHub OIDC is restricted to `Prenetics/battle-bus` on `refs/heads/main` and impersonates `battle-bus-deployer@battle-bus-509406.iam.gserviceaccount.com`. The deployer can update only the existing `battle-bus` Cloud Run service, push only to the `battle-bus` Artifact Registry repository, and attach only the `battle-bus-runtime` runtime identity.

The pipeline intentionally refuses to deploy if the Cloud Run service has an `allUsers` IAM binding. It also remains blocked whenever lint, tests, critical dependency auditing, or the application build fails.
