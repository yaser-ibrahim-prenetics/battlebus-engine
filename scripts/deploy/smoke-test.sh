#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}" "${CLOUD_RUN_SERVICE:?}"
: "${CANDIDATE_REVISION:?}" "${CANDIDATE_TAG:?}"

service="$(gcloud run services describe "${CLOUD_RUN_SERVICE}" \
  --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format=json)"
url="$(jq -er --arg tag "${CANDIDATE_TAG}" --arg revision "${CANDIDATE_REVISION}" \
  '.status.traffic[] | select(.tag == $tag and .revisionName == $revision) | .url' <<<"$service")"
if [ "${SMOKE_TARGET:-candidate}" = production ]; then
  url="$(jq -er '.status.url' <<<"$service")"
fi
[[ "$url" =~ ^https://[a-z0-9.-]+\.run\.app$ ]]
jq -e '.metadata.annotations["run.googleapis.com/minScale"] == "1"' <<<"$service" >/dev/null

# Bounded requests; failure is handled by candidate gating or promotion rollback.
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$url/api/health" \
  | jq -e --arg revision "${CANDIDATE_REVISION}" '.ok == true and .revision == $revision' >/dev/null
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$url/api/ready" \
  | jq -e '.ok == true' >/dev/null
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$url/api/inngest" \
  | jq -e '.function_count > 0 and .has_signing_key == true and .has_event_key == true' >/dev/null

# Application authentication must still reject unauthenticated internal calls.
status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  --output /dev/null --write-out '%{http_code}' "$url/api/readiness")"
[ "$status" = 401 ]
echo "Revision, database readiness, Inngest configuration, and API authentication passed (${SMOKE_TARGET:-candidate})."
