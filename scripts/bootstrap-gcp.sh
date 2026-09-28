#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-battle-bus-509406}"
region="${GCP_REGION:-asia-east1}"
repository="${ARTIFACT_REPOSITORY:-battle-bus}"
database_url_secret="${DATABASE_URL_SECRET:-battle-platform-database-url}"
migration_job="${MIGRATION_JOB:-battle-bus-migrate}"
pool_id="github-actions"
bus_provider_id="battle-platform-main"
hub_provider_id="battle-hub-main"
bus_repo="yaser-ibrahim-prenetics/battlebus-engine"
hub_repo="yaser-ibrahim-prenetics/battlehub-console"

gcloud config set project "${project_id}" >/dev/null
gcloud services enable \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sts.googleapis.com \
  --project="${project_id}"

if ! gcloud artifacts repositories describe "${repository}" \
  --location="${region}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${repository}" \
    --repository-format=docker \
    --location="${region}" \
    --description="Battle platform containers" \
    --project="${project_id}"
fi

ensure_service_account() {
  local account_id="$1"
  local display_name="$2"
  if ! gcloud iam service-accounts describe \
    "${account_id}@${project_id}.iam.gserviceaccount.com" \
    --project="${project_id}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${account_id}" \
      --display-name="${display_name}" \
      --project="${project_id}"
  fi
}

ensure_service_account "battle-bus-runtime" "Battle Bus Cloud Run runtime"
ensure_service_account "battle-bus-deployer" "Battle Bus GitHub deployer"
ensure_service_account "battle-bus-migrator" "Battle Bus database migration job"
ensure_service_account "battle-hub-runtime" "Battle Hub Cloud Run runtime"
ensure_service_account "battle-hub-deployer" "Battle Hub GitHub deployer"

if ! gcloud iam workload-identity-pools describe "${pool_id}" \
  --location=global --project="${project_id}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${pool_id}" \
    --location=global \
    --display-name="GitHub Actions" \
    --project="${project_id}"
fi

ensure_oidc_provider() {
  local provider_id="$1"
  local github_repository="$2"
  local condition="assertion.repository == '${github_repository}' && assertion.ref == 'refs/heads/main'"
  local provider_args=(
    "${provider_id}"
    "--location=global"
    "--workload-identity-pool=${pool_id}"
    "--issuer-uri=https://token.actions.githubusercontent.com"
    "--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
    "--attribute-condition=${condition}"
    "--project=${project_id}"
  )

  if gcloud iam workload-identity-pools providers describe "${provider_id}" \
    --location=global --workload-identity-pool="${pool_id}" \
    --project="${project_id}" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers update-oidc "${provider_args[@]}"
  else
    gcloud iam workload-identity-pools providers create-oidc "${provider_args[@]}"
  fi
}

ensure_oidc_provider "${bus_provider_id}" "${bus_repo}"
ensure_oidc_provider "${hub_provider_id}" "${hub_repo}"

grant_repository_writer() {
  local service_account="$1"
  gcloud artifacts repositories add-iam-policy-binding "${repository}" \
    --location="${region}" \
    --member="serviceAccount:${service_account}@${project_id}.iam.gserviceaccount.com" \
    --role=roles/artifactregistry.writer \
    --project="${project_id}" \
    --quiet >/dev/null
}

grant_service_admin() {
  local service_account="$1"
  local service_name="$2"
  if ! gcloud run services describe "${service_name}" \
    --region="${region}" --project="${project_id}" >/dev/null 2>&1; then
    printf 'Cloud Run service %s does not exist; skipping its resource-scoped deployer binding.\n' \
      "${service_name}" >&2
    return
  fi
  gcloud run services add-iam-policy-binding "${service_name}" \
    --region="${region}" \
    --member="serviceAccount:${service_account}@${project_id}.iam.gserviceaccount.com" \
    --role=roles/run.admin \
    --project="${project_id}" \
    --quiet >/dev/null
}

grant_repository_writer battle-bus-deployer
grant_repository_writer battle-hub-deployer
grant_service_admin battle-bus-deployer battle-bus
grant_service_admin battle-hub-deployer battle-hub

project_number="$(gcloud projects describe "${project_id}" --format='value(projectNumber)')"

bind_repository() {
  local deployer="$1"
  local github_repository="$2"
  gcloud iam service-accounts add-iam-policy-binding \
    "${deployer}@${project_id}.iam.gserviceaccount.com" \
    --member="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/attribute.repository/${github_repository}" \
    --role=roles/iam.workloadIdentityUser \
    --project="${project_id}" \
    --quiet >/dev/null
}

allow_runtime_identity() {
  local deployer="$1"
  local runtime="$2"
  gcloud iam service-accounts add-iam-policy-binding \
    "${runtime}@${project_id}.iam.gserviceaccount.com" \
    --member="serviceAccount:${deployer}@${project_id}.iam.gserviceaccount.com" \
    --role=roles/iam.serviceAccountUser \
    --project="${project_id}" \
    --quiet >/dev/null
}

bind_repository battle-bus-deployer "${bus_repo}"
bind_repository battle-hub-deployer "${hub_repo}"
allow_runtime_identity battle-bus-deployer battle-bus-runtime
allow_runtime_identity battle-bus-deployer battle-bus-migrator
allow_runtime_identity battle-hub-deployer battle-hub-runtime

if ! gcloud secrets describe "${database_url_secret}" \
  --project="${project_id}" >/dev/null 2>&1; then
  gcloud secrets create "${database_url_secret}" \
    --replication-policy=automatic \
    --project="${project_id}"
fi

gcloud secrets add-iam-policy-binding "${database_url_secret}" \
  --member="serviceAccount:battle-bus-migrator@${project_id}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor \
  --project="${project_id}" \
  --quiet >/dev/null

# The deployer configures only a secret reference on the migration job. It does
# not need to read the privileged database URL itself.
gcloud secrets remove-iam-policy-binding "${database_url_secret}" \
  --member="serviceAccount:battle-bus-deployer@${project_id}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor \
  --project="${project_id}" \
  --quiet >/dev/null 2>&1 || true

bus_provider_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${bus_provider_id}"
hub_provider_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${hub_provider_id}"
printf 'GCP bootstrap complete.\nBattle Bus Workload Identity Provider: %s\n' "${bus_provider_name}"
printf 'Battle Hub Workload Identity Provider: %s\n' "${hub_provider_name}"
printf 'Migration identity: battle-bus-migrator@%s.iam.gserviceaccount.com\n' "${project_id}"
printf 'After pushing a migration image and creating a numeric database secret version, bootstrap %s with scripts/bootstrap-migration-job.sh.\n' "${migration_job}"
printf 'Deployment remains disabled until the repository Actions variable ENABLE_GCP_DEPLOY=true is set.\n'
