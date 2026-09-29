#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-battle-bus-509406}"
region="${GCP_REGION:-asia-east1}"
instance="${CLOUD_SQL_INSTANCE_NAME:-battle-platform-staging-pg16}"
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT:-battle-bus-runtime@${project_id}.iam.gserviceaccount.com}"
runtime_database_user="${DB_USER:-${runtime_service_account%.gserviceaccount.com}}"

if [[ "${runtime_service_account}" != *@"${project_id}".iam.gserviceaccount.com ]]; then
  echo "RUNTIME_SERVICE_ACCOUNT must belong to ${project_id}." >&2
  exit 1
fi

gcloud sql instances describe "${instance}" --project="${project_id}" >/dev/null
gcloud iam service-accounts describe "${runtime_service_account}" --project="${project_id}" >/dev/null

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

iam_authentication="$(gcloud sql instances describe "${instance}" \
  --project="${project_id}" \
  --format=json | jq -r '.settings.databaseFlags[]? | select(.name == "cloudsql.iam_authentication") | .value')"
if [[ "$(printf '%s' "${iam_authentication}" | tr '[:upper:]' '[:lower:]')" != "on" ]]; then
  echo "Cloud SQL IAM database authentication is not enabled on ${instance}." >&2
  echo "Enable cloudsql.iam_authentication=on without removing any existing database flags, then rerun." >&2
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

condition="expression=resource.name == 'projects/${project_id}/instances/${instance}' && resource.service == 'sqladmin.googleapis.com',title=BattleBusRuntimeInstanceOnly,description=Connect only to the Battle Platform runtime instance"
for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
  gcloud projects add-iam-policy-binding "${project_id}" \
    --member="serviceAccount:${runtime_service_account}" \
    --role="${role}" \
    --condition="${condition}" \
    --quiet >/dev/null
done

printf 'Cloud SQL runtime identity is ready.\nInstance: %s:%s:%s\nDatabase IAM user: %s\n' \
  "${project_id}" "${region}" "${instance}" "${runtime_database_user}"
printf 'Run database migrations next so battle_bus_runtime is granted to the IAM database user.\n'
