#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-battle-bus-509406}"
region="${GCP_REGION:-asia-east1}"
repository="${ARTIFACT_REPOSITORY:-battle-bus}"
pool_id="github-actions"
provider_id="battle-platform-main"
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
ensure_service_account "battle-hub-runtime" "Battle Hub Cloud Run runtime"
ensure_service_account "battle-hub-deployer" "Battle Hub GitHub deployer"

if ! gcloud iam workload-identity-pools describe "${pool_id}" \
  --location=global --project="${project_id}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${pool_id}" \
    --location=global \
    --display-name="GitHub Actions" \
    --project="${project_id}"
fi

condition="assertion.repository == '${bus_repo}' || assertion.repository == '${hub_repo}'"
provider_args=(
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

grant_project_role() {
  local service_account="$1"
  local role="$2"
  gcloud projects add-iam-policy-binding "${project_id}" \
    --member="serviceAccount:${service_account}@${project_id}.iam.gserviceaccount.com" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
}

for deployer in battle-bus-deployer battle-hub-deployer; do
  grant_project_role "${deployer}" roles/artifactregistry.writer
  grant_project_role "${deployer}" roles/run.admin
done

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
allow_runtime_identity battle-hub-deployer battle-hub-runtime

provider_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${provider_id}"
printf 'GCP bootstrap complete.\nWorkload Identity Provider: %s\n' "${provider_name}"
printf 'Deployment remains disabled until ENABLE_GCP_DEPLOY=true is set in each GitHub gcp-production environment.\n'
