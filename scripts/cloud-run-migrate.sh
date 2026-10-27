#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required." >&2
  exit 1
fi

if [ -z "${MIGRATION_RELEASE_SHA:-}" ]; then
  echo "MIGRATION_RELEASE_SHA is required for auditability." >&2
  exit 1
fi

case "${DATABASE_URL_SECRET_VERSION:-}" in
  ""|*[!0-9]*)
    echo "DATABASE_URL_SECRET_VERSION must be a pinned numeric Secret Manager version." >&2
    exit 1
    ;;
esac

command_name="${1:-up}"
case "${command_name}" in
  up|version) ;;
  *)
    echo "Unsupported migration command: ${command_name}. Only up and version are allowed." >&2
    exit 1
    ;;
esac

if [ -n "${CLOUD_SQL_INSTANCE_CONNECTION_NAME:-}" ]; then
  if ! printf '%s' "$CLOUD_SQL_INSTANCE_CONNECTION_NAME" | grep -Eq '^[a-z][a-z0-9-]+:[a-z][a-z0-9-]+:[a-z][a-z0-9-]+$'; then
    echo "Invalid Cloud SQL instance connection name." >&2
    exit 1
  fi
  case "$DATABASE_URL" in
    postgres://*@*/*|postgresql://*@*/*) ;;
    *) echo "Unexpected database URL format." >&2; exit 1 ;;
  esac
  # The shared migration secret may target a local proxy. Keep its credentials
  # and database name, but connect through the job's mounted Cloud SQL socket.
  DATABASE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#@[^/]+/#@/#; s#\?.*$##')?host=/cloudsql/${CLOUD_SQL_INSTANCE_CONNECTION_NAME}&sslmode=disable"
  export DATABASE_URL
fi

echo "Running Battle Bus migration command ${command_name} for release ${MIGRATION_RELEASE_SHA} with database secret version ${DATABASE_URL_SECRET_VERSION}."

# migrate can include its full connection URL in failures. Never send that raw
# output to Cloud Logging or GitHub logs, which have a wider readership.
log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT
if /usr/local/bin/migrate \
  -path /migrations \
  -database "${DATABASE_URL}" \
  "${command_name}" >"$log_file" 2>&1; then
  cat "$log_file"
else
  status=$?
  echo "Migration command failed (exit ${status}); raw database diagnostics withheld to protect credentials." >&2
  exit "$status"
fi

if [ "${command_name}" = "up" ]; then
  echo "Battle Bus migrations completed for release ${MIGRATION_RELEASE_SHA}."
else
  echo "Battle Bus migration version check completed for release ${MIGRATION_RELEASE_SHA}."
fi
