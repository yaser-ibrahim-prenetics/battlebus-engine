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

echo "Applying Battle Bus migrations for release ${MIGRATION_RELEASE_SHA} with database secret version ${DATABASE_URL_SECRET_VERSION}."
/usr/local/bin/migrate \
  -path file:///migrations \
  -database "${DATABASE_URL}" \
  up
echo "Battle Bus migrations completed for release ${MIGRATION_RELEASE_SHA}."
