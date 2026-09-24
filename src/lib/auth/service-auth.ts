// ============================================================================
// SERVICE AUTH GATE (fail-closed)
// ============================================================================
// Shared helper for gating internal/service-to-service mutation, debug and
// configuration routes behind a shared-secret credential.
//
// Credentials are accepted via:
//   - `x-api-key: <secret>` header, or
//   - `Authorization: Bearer <secret>` header
//
// The credential is compared (timing-safe) against the first non-empty env
// var found in `opts.envVars` (default: ["BATTLE_BUS_API_KEY"]).
//
// IMPORTANT: this fails CLOSED. If none of the candidate env vars are set,
// the request is DENIED (500 service_auth_not_configured) — it is never
// silently allowed through just because no secret has been configured.

import { timingSafeEqual } from "@/lib/auth/timing-safe-equal";

export type ServiceAuthResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

const DEFAULT_ENV_VARS = ["BATTLE_BUS_API_KEY"];

function extractCredential(request: Request): string {
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader && apiKeyHeader.trim()) return apiKeyHeader.trim();

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && match[1].trim()) return match[1].trim();

  return "";
}

export function requireServiceAuth(
  request: Request,
  opts?: { envVars?: string[] }
): ServiceAuthResult {
  const envVarNames = opts?.envVars && opts.envVars.length > 0 ? opts.envVars : DEFAULT_ENV_VARS;

  const expected = envVarNames
    .map((name) => (process.env[name] || "").trim())
    .find((value) => value.length > 0);

  if (!expected) {
    return {
      ok: false,
      status: 500,
      body: { error: "service_auth_not_configured" },
    };
  }

  const credential = extractCredential(request);
  if (!credential || !timingSafeEqual(credential, expected)) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    };
  }

  return { ok: true };
}
