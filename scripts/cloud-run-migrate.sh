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

echo "Running Battle Bus migration command ${command_name} for release ${MIGRATION_RELEASE_SHA} with database secret version ${DATABASE_URL_SECRET_VERSION}."

/usr/local/bin/migrate \
  -path /migrations \
  -database "${DATABASE_URL}" \
  "${command_name}"

if [ "${command_name}" = "up" ]; then
  echo "Battle Bus migrations completed for release ${MIGRATION_RELEASE_SHA}."
else
  echo "Battle Bus migration version check completed for release ${MIGRATION_RELEASE_SHA}."
fi
