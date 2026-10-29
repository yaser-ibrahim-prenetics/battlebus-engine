# Shared provider concurrency

This document defines PR 5 of the Spock Store replacement sequence. PR 4 completed the originally
separate typed-inventory, transactional-parking and keyed-drain scopes, so the next unfinished P0
requirement is provider-wide capacity enforcement.

## Contract

- D365, GPS and Shopify requests acquire capacity at the lowest shared HTTP-client boundary.
  Therefore order, fulfillment, refund, cancellation, backorder, reconciliation, inventory and
  administrative workflows consume the same provider pool even when they run in different Inngest
  functions or Cloud Run instances.
- Capacity is stored in PostgreSQL slots and claimed with `FOR UPDATE SKIP LOCKED`. A slot has an
  exact lease token and bounded expiry. Release and renewal must match that token, so a stale worker
  cannot release a newer claim.
- A caller waits only for a bounded interval. Capacity exhaustion fails with a safe retryable error;
  provider work is never silently discarded.
- The feature deploys disabled. When disabled, provider clients retain their current behavior and
  do not require PostgreSQL. Activation requires migration 52 and explicit configuration.
- Lease rows contain only provider, slot, UUID ownership, a SHA-256 operation digest and timestamps.
  Provider payloads, credentials, URLs and customer data are never persisted.
- Existing fulfillment-action and OOS mutation records remain responsible for stable business
  identity and ambiguous-result recovery. Capacity leases limit simultaneous calls; they do not
  replace idempotency evidence.

## Providers

The schema reserves capacity namespaces for `d365`, `gps`, `shopify`, `stord` and `loop`.

Battle Bus currently has outbound client boundaries for D365, GPS and Shopify. STORD and Loop are
inbound-only in the current active scope, so their namespaces are reserved without adding artificial
limits to webhook ingestion. Any future outbound client must use its reserved namespace.

## Configuration

| Variable                                  | Default | Range  |
| ----------------------------------------- | ------: | ------ |
| `PROVIDER_CAPACITY_ENABLED`               | `false` | bool   |
| `PROVIDER_CAPACITY_D365_LIMIT`            |     `4` | 1–100  |
| `PROVIDER_CAPACITY_GPS_LIMIT`             |     `4` | 1–100  |
| `PROVIDER_CAPACITY_SHOPIFY_LIMIT`         |     `8` | 1–100  |
| `PROVIDER_CAPACITY_STORD_LIMIT`           |     `4` | 1–100  |
| `PROVIDER_CAPACITY_LOOP_LIMIT`            |     `4` | 1–100  |
| `PROVIDER_CAPACITY_LEASE_SECONDS`         |   `120` | 30–600 |
| `PROVIDER_CAPACITY_ACQUIRE_TIMEOUT_MS`    | `30000` | 1–60 s |
| `PROVIDER_CAPACITY_ACQUIRE_POLL_INTERVAL` |   `250` | 25–2 s |

## Acceptance criteria

- Concurrent callers for one provider never exceed its configured slot count.
- Different providers do not block one another.
- Expired claims are recoverable after a worker crash.
- Exact-token renewal and release cannot modify a newer lease.
- Disabled mode performs no database access.
- Operations health reports active and expired slots per provider without exposing operation data.
