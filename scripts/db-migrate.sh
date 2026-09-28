#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required." >&2
  exit 1
fi

migrate_bin="${MIGRATE_BIN:-migrate}"
if ! command -v "${migrate_bin}" >/dev/null 2>&1; then
  echo "golang-migrate is not installed. See db/README.md." >&2
  exit 1
fi

command_name="${1:-up}"
shift || true

if [[ "${command_name}" == "drop" ]]; then
  echo "The destructive golang-migrate drop command is disabled." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${migrate_bin}" \
  -path "${repo_root}/db/migrations" \
  -database "${DATABASE_URL}" \
  "${command_name}" "$@"
