# 001: Private Hub service connections

- Date: 2026-10-22
- Status: Accepted

## Context

Hub moved to IAP-protected Cloud Run with its own Cloud SQL database. Existing
callbacks sent only an HMAC and were redirected to Google sign-in. The live Bus
configuration also omitted Hub URLs and Shopify test read credentials.

## Decision

Use one callback transport for order/product/location/inventory webhooks and the
location-mapping read. Google IAM signs ten-minute service-account JWTs for the
configured Hub origin, cached until one minute before expiry. Payloads retain
HMAC signatures. Redirects are rejected, calls are bounded, and Cloud Run fails
closed if IAP authentication is not configured. No downloaded private keys.

Deployments configure `CS_PLATFORM_URL`, `BATTLE_HUB_URL`, the exact caller
identity, and pinned existing Secret Manager references. Bus gets self-only
Token Creator, Hub-specific IAP access, and access to the specific shared HMAC and
Shopify test configuration. Hub gets the existing Bus API key. No production
Shopify token or provider-write flags are enabled.

## Rationale

This preserves the private UI and separates transport authentication from payload
authentication. It follows Google's IAP service-account JWT guidance:
https://docs.cloud.google.com/iap/docs/authentication-howto

## Consequences

`GET /api/integration/hub` requires Bus API authentication and sends only a
correlated, no-write webhook probe plus a location-mapping read. `/api/readiness`
checks SQL connectivity and labels other dependency checks as configuration only.
Neither endpoint queues work or calls a business provider.

`DRY_RUN_MODE=true` stays enabled. Real Hub business projections remain suppressed
in dry-run so simulated provider results are not recorded as real orders. The
legacy pending-action drain also stops in dry-run. The main branch's old Hub-owned
pending-action write contract must be replaced by the separately developed durable
Bus-owned lifecycle implementation before live lifecycle processing is enabled.

Deploy Hub first, then Bus. Reuse the existing GitHub deployment pipelines and
validate `/api/integration/status` through a signed-in Hub browser afterward.
