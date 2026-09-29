#!/usr/bin/env bash
set -euo pipefail

project_id="battle-bus-509406"
region="${GCP_REGION:-asia-east1}"
instance="${CLOUD_SQL_INSTANCE_NAME:-battle-platform-staging-pg16}"
runtime_service_account="battle-hub-runtime@battle-bus-509406.iam.gserviceaccount.com"
runtime_database_user="battle-hub-runtime@battle-bus-509406.iam"

assert_pinned_identity() {
  local variable_name="$1"
  local configured_value="$2"
  local expected_value="$3"

  if [[ -n "${configured_value}" && "${configured_value}" != "${expected_value}" ]]; then
    echo "${variable_name} is pinned to ${expected_value}; update migration 000008 before changing it." >&2
    exit 1
  fi
}

assert_pinned_identity "GCP_PROJECT_ID" "${GCP_PROJECT_ID:-}" "${project_id}"
assert_pinned_identity \
  "HUB_RUNTIME_SERVICE_ACCOUNT" \
  "${HUB_RUNTIME_SERVICE_ACCOUNT:-}" \
  "${runtime_service_account}"
assert_pinned_identity "HUB_DB_USER" "${HUB_DB_USER:-}" "${runtime_database_user}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

gcloud sql instances describe "${instance}" --project="${project_id}" >/dev/null
gcloud iam service-accounts describe "${runtime_service_account}" --project="${project_id}" >/dev/null

iam_authentication="$(gcloud sql instances describe "${instance}" \
  --project="${project_id}" \
  --format=json | jq -r '.settings.databaseFlags[]? | select(.name == "cloudsql.iam_authentication") | .value')"
if [[ "$(printf '%s' "${iam_authentication}" | tr '[:upper:]' '[:lower:]')" != "on" ]]; then
  echo "Cloud SQL IAM database authentication is not enabled on ${instance}." >&2
  exit 1
fi

if ! gcloud sql users list \
  --instance="${instance}" \
  --project="${project_id}" \
  --filter="name=${runtime_database_user}" \
  --format="value(name)" | grep -Fxq "${runtime_database_user}"; then
  gcloud sql users create "${runtime_database_user}" \
    --instance="${instance}" \
    --type=cloud_iam_service_account \
    --project="${project_id}"
fi

condition="expression=resource.name == 'projects/${project_id}/instances/${instance}' && resource.service == 'sqladmin.googleapis.com',title=BattleHubRuntimeInstanceOnly,description=Connect only to the Battle Platform runtime instance"
for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
  gcloud projects add-iam-policy-binding "${project_id}" \
    --member="serviceAccount:${runtime_service_account}" \
    --role="${role}" \
    --condition="${condition}" \
    --quiet >/dev/null
done

printf 'Battle Hub Cloud SQL identity is ready.\nInstance: %s:%s:%s\nDatabase IAM user: %s\n' \
  "${project_id}" "${region}" "${instance}" "${runtime_database_user}"
printf 'Run database migrations next so battle_hub_runtime is granted to the IAM database user.\n'
