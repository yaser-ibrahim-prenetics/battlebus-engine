#!/usr/bin/env bash
set -euo pipefail
: "${CLOUD_RUN_URL:?}" "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}" "${CLOUD_RUN_SERVICE:?}" "${CANDIDATE_REVISION:?}"
# Registration only; this does not publish a business event.
curl --fail --show-error --silent --connect-timeout 10 --max-time 60 \
  --request PUT --retry 3 --retry-delay 2 --retry-all-errors \
  "${CLOUD_RUN_URL}/api/inngest" \
  | jq --exit-status 'has("modified") and (.message | type == "string")'
echo "Inngest synced to ${CLOUD_RUN_URL}/api/inngest"
gcloud run services update "${CLOUD_RUN_SERVICE}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --update-labels="inngest-synced-revision=${CANDIDATE_REVISION}" \
  --quiet
echo "Recorded Inngest sync marker for ${CANDIDATE_REVISION}"
