#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required." >&2
  exit 1
fi

if [[ -z "${BATTLE_HUB_ADMIN_EMAIL:-}" ]]; then
  echo "BATTLE_HUB_ADMIN_EMAIL is required." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql "${DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --set "admin_email=${BATTLE_HUB_ADMIN_EMAIL}" \
  --file "${repo_root}/db/admin/bootstrap_superadmin.sql"
