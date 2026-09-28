#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-battle-bus-509406}"
region="${GCP_REGION:-asia-east1}"
migration_job="${MIGRATION_JOB:-battle-bus-migrate}"
database_url_secret="${DATABASE_URL_SECRET:-battle-platform-database-url}"
migration_service_account="${MIGRATION_SERVICE_ACCOUNT:-battle-bus-migrator@${project_id}.iam.gserviceaccount.com}"
deployer_service_account="${DEPLOY_SERVICE_ACCOUNT:-battle-bus-deployer@${project_id}.iam.gserviceaccount.com}"
migration_image_uri="${MIGRATION_IMAGE_URI:-}"
database_url_secret_version="${DATABASE_URL_SECRET_VERSION:-}"
migration_release_sha="${MIGRATION_RELEASE_SHA:-}"

if [[ -z "${migration_image_uri}" ]]; then
  echo "MIGRATION_IMAGE_URI is required." >&2
  exit 1
fi

if [[ ! "${database_url_secret_version}" =~ ^[0-9]+$ ]]; then
  echo "DATABASE_URL_SECRET_VERSION must be a pinned numeric Secret Manager version." >&2
  exit 1
fi

if [[ ! "${migration_release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "MIGRATION_RELEASE_SHA must be the full 40-character Git commit SHA." >&2
  exit 1
fi

if [[ "${migration_image_uri}" != "${region}-docker.pkg.dev/${project_id}/"* ]]; then
  echo "MIGRATION_IMAGE_URI must come from this project's ${region} Artifact Registry." >&2
  exit 1
fi

if [[ "${migration_image_uri}" != *":${migration_release_sha}" && "${migration_image_uri}" != *@sha256:* ]]; then
  echo "MIGRATION_IMAGE_URI must use the release SHA tag or an immutable sha256 digest." >&2
  exit 1
fi

for account in "${migration_service_account}" "${deployer_service_account}"; do
  if ! gcloud iam service-accounts describe "${account}" \
    --project="${project_id}" >/dev/null 2>&1; then
    echo "Missing service account: ${account}. Run scripts/bootstrap-gcp.sh first." >&2
    exit 1
  fi
done

secret_state="$(gcloud secrets versions describe "${database_url_secret_version}" \
  --secret="${database_url_secret}" \
  --project="${project_id}" \
  --format='value(state)')"
if [[ "${secret_state}" != "ENABLED" ]]; then
  echo "${database_url_secret} version ${database_url_secret_version} is not enabled." >&2
  exit 1
fi

gcloud secrets add-iam-policy-binding "${database_url_secret}" \
  --member="serviceAccount:${migration_service_account}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${project_id}" \
  --quiet >/dev/null

gcloud iam service-accounts add-iam-policy-binding "${migration_service_account}" \
  --member="serviceAccount:${deployer_service_account}" \
  --role=roles/iam.serviceAccountUser \
  --project="${project_id}" \
  --quiet >/dev/null

gcloud run jobs deploy "${migration_job}" \
  --image="${migration_image_uri}" \
  --region="${region}" \
  --project="${project_id}" \
  --service-account="${migration_service_account}" \
  --set-secrets="DATABASE_URL=${database_url_secret}:${database_url_secret_version}" \
  --set-env-vars="MIGRATION_RELEASE_SHA=${migration_release_sha},DATABASE_URL_SECRET_VERSION=${database_url_secret_version}" \
  --tasks=1 \
  --parallelism=1 \
  --max-retries=0 \
  --task-timeout=900s \
  --cpu=1 \
  --memory=512Mi \
  --quiet

gcloud run jobs add-iam-policy-binding "${migration_job}" \
  --region="${region}" \
  --project="${project_id}" \
  --member="serviceAccount:${deployer_service_account}" \
  --role=roles/run.developer \
  --quiet >/dev/null

gcloud secrets remove-iam-policy-binding "${database_url_secret}" \
  --member="serviceAccount:${deployer_service_account}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${project_id}" \
  --quiet >/dev/null 2>&1 || true

printf 'Bootstrapped Cloud Run migration job %s with image %s and secret version %s.\n' \
  "${migration_job}" "${migration_image_uri}" "${database_url_secret_version}"
printf 'The job was not executed. The Battle Bus deployment workflow runs it after validation.\n'
