#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}" "${CLOUD_RUN_SERVICE:?}"
: "${CANDIDATE_REVISION:?}" "${PREVIOUS_TRAFFIC:?}"
if [ "$#" -eq 0 ]; then echo "A production smoke-test command is required."; exit 1; fi

# Arm rollback BEFORE requesting promotion: an API timeout can occur after
# traffic changes. EXIT also catches explicit failures in the verification loop.
rollback_armed=false
on_exit() {
  result=$?
  trap - EXIT INT TERM
  if [ "$result" -ne 0 ] && [ "$rollback_armed" = true ]; then
    echo "Release failed; restoring serving allocation: ${PREVIOUS_TRAFFIC}"
    if gcloud run services update-traffic "${CLOUD_RUN_SERVICE}" \
      --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" \
      --to-revisions="${PREVIOUS_TRAFFIC}" --quiet; then
      echo "Rollback applied: ${PREVIOUS_TRAFFIC}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    else
      echo "::error::Automatic rollback failed. Restore ${PREVIOUS_TRAFFIC} manually."
    fi
  fi
  exit "$result"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rollback_armed=true
gcloud run services update-traffic "${CLOUD_RUN_SERVICE}" \
  --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" \
  --to-revisions="${CANDIDATE_REVISION}=100" --quiet

export SMOKE_TARGET=production
# Allow bounded routing propagation, then require three consecutive successful
# samples. The callback verifies the expected revision on the canonical URL.
consecutive=0
for attempt in $(seq 1 12); do
  if "$@"; then
    consecutive=$((consecutive + 1))
    if [ "$consecutive" -eq 3 ]; then break; fi
  else
    consecutive=0
  fi
  sleep 5
done
if [ "$consecutive" -ne 3 ]; then
  echo "::error::Production verification did not stabilize."
  exit 1
fi
if [ -n "${POST_PROMOTION_HOOK:-}" ]; then
  bash "${POST_PROMOTION_HOOK}"
fi
rollback_armed=false
echo "Verified ${CANDIDATE_REVISION} at 100%; previous traffic: ${PREVIOUS_TRAFFIC}" \
  | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
