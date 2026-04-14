#!/usr/bin/env bash
# Bulk-push environment variables to a Vercel project using the Vercel CLI.
#
# Prerequisites:
#   - vercel CLI installed and logged in (`vercel login`)
#   - This repo linked to the target project (`vercel link` from the inngest/ root)
#
# Usage:
#   ./scripts/vercel-push-env-from-file.sh production ./my-production.env
#   ./scripts/vercel-push-env-from-file.sh preview ./my-preview.env
#   ./scripts/vercel-push-env-from-file.sh development ./my-local.env
#
# Optional:
#   VERCEL_USE_SENSITIVE=1   — pass --sensitive on every line (recommended for tokens)
#
# Dotenv file format (same as .env):
#   KEY=value
#   # comments and blank lines ignored
#   VALUE may contain = ; only the first = splits key from value
#
# Common Battle Bus keys (see src/lib/config.ts): D365_*, GPS_*, GPS_UK_*,
# SHOPIFY_STORE_MODE, SHOPIFY_PROD_* / SHOPIFY_TEST_*, etc.
#
set -euo pipefail

VERCEL_TARGET="${1:?First arg: Vercel environment — production | preview | development}"
ENV_FILE="${2:?Second arg: path to dotenv file}"

case "$VERCEL_TARGET" in
  production|preview|development) ;;
  *) echo "Invalid Vercel environment: $VERCEL_TARGET (use production, preview, or development)" >&2; exit 1 ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "File not found: $ENV_FILE" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SENSITIVE_FLAGS=()
if [[ "${VERCEL_USE_SENSITIVE:-}" == "1" ]]; then
  SENSITIVE_FLAGS=(--sensitive)
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" != *"="* ]] && continue

  key="${line%%=*}"
  value="${line#*=}"
  key="${key%"${key##*[![:space:]]}"}"
  key="${key#"${key%%[![:space:]]*}"}"

  [[ -z "$key" ]] && continue

  # Strip surrounding single/double quotes on value
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi

  echo "+ $key"
  vercel env add "$key" "$VERCEL_TARGET" --value "$value" --yes --force "${SENSITIVE_FLAGS[@]}"
done < "$ENV_FILE"

echo "Done. Pushed keys from $ENV_FILE → $VERCEL_TARGET"
