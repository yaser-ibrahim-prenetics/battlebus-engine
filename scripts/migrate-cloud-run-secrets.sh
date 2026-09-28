#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-battle-bus-509406}"
region="${GCP_REGION:-asia-east1}"
service="${CLOUD_RUN_SERVICE:-battle-bus}"
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT:-battle-bus-runtime@${project_id}.iam.gserviceaccount.com}"
secret_env_file="${SECRET_ENV_FILE:-config/gcp-secret-env-names.txt}"

if [[ ! -f "${secret_env_file}" ]]; then
  printf 'Secret inventory file not found: %s\n' "${secret_env_file}" >&2
  exit 1
fi

for dependency in gcloud jq curl; do
  if ! command -v "${dependency}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${dependency}" >&2
    exit 1
  fi
done

service_json="$(mktemp "${TMPDIR:-/tmp}/battle-bus-service.XXXXXX.json")"
chmod 600 "${service_json}"
cleanup() {
  rm -f "${service_json}"
}
trap cleanup EXIT

gcloud run services describe "${service}" \
  --region="${region}" \
  --project="${project_id}" \
  --format=json >"${service_json}"

previous_revision="$(jq -r '.status.latestReadyRevisionName // empty' "${service_json}")"
service_url="$(jq -r '.status.url // empty' "${service_json}")"
if [[ -z "${previous_revision}" || -z "${service_url}" ]]; then
  printf 'Cloud Run did not report a ready revision and service URL.\n' >&2
  exit 1
fi

bindings=()
migrated_names=()
already_managed_names=()
missing_names=()

while IFS= read -r env_name; do
  [[ -z "${env_name}" || "${env_name}" == \#* ]] && continue
  if [[ ! "${env_name}" =~ ^[A-Z][A-Z0-9_]+$ ]]; then
    printf 'Invalid environment variable name in %s: %s\n' "${secret_env_file}" "${env_name}" >&2
    exit 1
  fi

  entry_kind="$(jq -r --arg name "${env_name}" '
    [.spec.template.spec.containers[0].env[]? | select(.name == $name)] as $entries
    | if ($entries | length) == 0 then "missing"
      elif ($entries[0].valueFrom.secretKeyRef? != null) then "secret"
      elif ($entries[0] | has("value")) then "plaintext"
      else "unsupported"
      end
  ' "${service_json}")"

  case "${entry_kind}" in
    missing)
      missing_names+=("${env_name}")
      continue
      ;;
    secret)
      already_managed_names+=("${env_name}")
      continue
      ;;
    plaintext)
      ;;
    *)
      printf 'Unsupported Cloud Run environment entry for %s.\n' "${env_name}" >&2
      exit 1
      ;;
  esac

  value_length="$(jq -r --arg name "${env_name}" '
    .spec.template.spec.containers[0].env[]
    | select(.name == $name)
    | (.value // "")
    | length
  ' "${service_json}")"
  if [[ "${value_length}" == "0" ]]; then
    printf 'Refusing to create an empty secret version for %s.\n' "${env_name}" >&2
    exit 1
  fi

  secret_suffix="$(printf '%s' "${env_name}" | tr '[:upper:]_' '[:lower:]-')"
  secret_id="battle-bus-${secret_suffix}"
  if ! gcloud secrets describe "${secret_id}" --project="${project_id}" >/dev/null 2>&1; then
    gcloud secrets create "${secret_id}" \
      --replication-policy=automatic \
      --project="${project_id}" >/dev/null
  fi

  jq -r --arg name "${env_name}" '
    .spec.template.spec.containers[0].env[]
    | select(.name == $name)
    | .value
  ' "${service_json}" \
    | gcloud secrets versions add "${secret_id}" \
        --data-file=- \
        --project="${project_id}" >/dev/null

  gcloud secrets add-iam-policy-binding "${secret_id}" \
    --member="serviceAccount:${runtime_service_account}" \
    --role=roles/secretmanager.secretAccessor \
    --project="${project_id}" \
    --quiet >/dev/null

  bindings+=("${env_name}=${secret_id}:latest")
  migrated_names+=("${env_name}")
done <"${secret_env_file}"

if (( ${#bindings[@]} == 0 )); then
  printf 'No plaintext secret environment variables require migration.\n'
  printf 'Already Secret Manager-backed: %s\n' "${#already_managed_names[@]}"
  printf 'Not configured on this service: %s\n' "${#missing_names[@]}"
  exit 0
fi

bindings_csv="$(IFS=,; printf '%s' "${bindings[*]}")"
candidate_tag="secrets-$(date -u +%Y%m%d%H%M%S)"

gcloud run services update "${service}" \
  --region="${region}" \
  --project="${project_id}" \
  --service-account="${runtime_service_account}" \
  --update-secrets="${bindings_csv}" \
  --no-traffic \
  --tag="${candidate_tag}" \
  --quiet >/dev/null

candidate_revision="$(gcloud run services describe "${service}" \
  --region="${region}" \
  --project="${project_id}" \
  --format='value(status.latestCreatedRevisionName)')"
candidate_url="$(gcloud run services describe "${service}" \
  --region="${region}" \
  --project="${project_id}" \
  --format=json | jq -r --arg tag "${candidate_tag}" '.status.traffic[]? | select(.tag == $tag) | .url')"

ready_status="$(gcloud run revisions describe "${candidate_revision}" \
  --region="${region}" \
  --project="${project_id}" \
  --format=json | jq -r '.status.conditions[] | select(.type == "Ready") | .status')"
if [[ "${ready_status}" != "True" || -z "${candidate_url}" ]]; then
  printf 'Secret Manager candidate revision is not ready; traffic remains on %s.\n' "${previous_revision}" >&2
  exit 1
fi

curl --fail --show-error --silent \
  --retry 10 --retry-delay 2 --retry-all-errors \
  "${candidate_url}/api/health" \
  | jq --exit-status '.ok == true and .service == "battle-bus"' >/dev/null

curl --fail --show-error --silent \
  --retry 10 --retry-delay 2 --retry-all-errors \
  "${candidate_url}/api/inngest" \
  | jq --exit-status '.function_count > 0 and .has_signing_key == true and .has_event_key == true' >/dev/null

gcloud run services update-traffic "${service}" \
  --region="${region}" \
  --project="${project_id}" \
  --to-revisions="${candidate_revision}=100" \
  --quiet >/dev/null

printf 'Promoted Secret Manager-backed revision: %s\n' "${candidate_revision}"
printf 'Migrated variables (%s):\n' "${#migrated_names[@]}"
printf '  %s\n' "${migrated_names[@]}"
printf 'Already Secret Manager-backed: %s\n' "${#already_managed_names[@]}"
printf 'Not configured on this service: %s\n' "${#missing_names[@]}"
printf 'Previous revision retained for rollback: %s\n' "${previous_revision}"
