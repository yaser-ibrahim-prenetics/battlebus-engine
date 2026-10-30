#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MIGRATION_TEST_DATABASE_URL:-}" ]]; then
  echo "MIGRATION_TEST_DATABASE_URL is required and must point to a disposable database." >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "${MIGRATION_TEST_DATABASE_URL}" == "${DATABASE_URL}" ]]; then
  echo "Refusing to run migration rollback tests against DATABASE_URL." >&2
  exit 1
fi

for executable in migrate psql; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    echo "${executable} is required." >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migration_args=(
  -path "${repo_root}/db/migrations"
  -database "${MIGRATION_TEST_DATABASE_URL}"
)

bootstrap_test_admin() {
  DATABASE_URL="${MIGRATION_TEST_DATABASE_URL}" \
    BATTLE_HUB_ADMIN_EMAIL="migration-admin@example.com" \
    bash "${repo_root}/scripts/db-bootstrap-admin.sh" >/dev/null
}

psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/bootstrap.sql"
# Reproduce an upgrade from the schema released on main before applying new work.
migrate "${migration_args[@]}" goto 56
migrate "${migration_args[@]}" up
bootstrap_test_admin
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/assertions_up.sql"
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/seed_fulfillment_housekeeping_rollback.sql"
migrate "${migration_args[@]}" down 1
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/assert_fulfillment_housekeeping_rollback.sql"
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --command "DELETE FROM public.fulfillment_actions WHERE action_key = 'housekeeping-rollback-fixture'"
migrate "${migration_args[@]}" up 1
migrate "${migration_args[@]}" down -all
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/assertions_down.sql"
migrate "${migration_args[@]}" up
bootstrap_test_admin
psql "${MIGRATION_TEST_DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file "${repo_root}/db/test/assertions_up.sql"
