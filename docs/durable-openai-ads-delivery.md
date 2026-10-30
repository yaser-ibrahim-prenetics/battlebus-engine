# Durable OpenAI Ads delivery

PR 6 adds a database-backed outbox for the OpenAI Ads `order_created` conversion. It is
independent of the D365 and fulfillment result: every eligible paid-order event is captured once,
then delivery proceeds asynchronously.

## Eligibility and identity

- Only `shopify/order.paid` and `shopify/subscription.renewed` events are considered.
- The payload must report `financial_status=paid` and must not be a synthetic test order.
- `OPENAI_ADS_ALLOWED_STORE` is compared with the canonical Shopify shop domain. A different store
  is recorded as skipped and never sent.
- The stable provider event ID is derived from the canonical store, canonical Shopify order ID and
  conversion type. A unique database constraint on those same fields prevents duplicate rows.
- Reruns and duplicate Shopify webhooks reuse the original order ID and conversion row.

The outbox retains only the canonical store, order ID, conversion type, event timestamp, stable
event ID, delivery state, attempts and sanitized delivery diagnostics. It does not retain Shopify
order payloads or customer identifiers.

## Configuration

The integration is disabled unless `OPENAI_ADS_ENABLED=true`. The API key is supplied through GCP
Secret Manager; the remaining values are ordinary Cloud Run environment settings.

| Variable | Purpose |
| --- | --- |
| `OPENAI_ADS_ENABLED` | Explicit delivery enable flag |
| `OPENAI_ADS_CONVERSIONS_API_KEY` | Secret Manager-backed bearer credential |
| `OPENAI_ADS_PIXEL_ID` | Pixel or dataset identifier |
| `OPENAI_ADS_ALLOWED_STORE` | Canonical Shopify shop domain allowed to send |
| `OPENAI_ADS_ENDPOINT` | HTTPS API origin; restricted to `bzr.openai.com` |
| `OPENAI_ADS_API_VERSION` | Provider API version, default `v1` |
| `OPENAI_ADS_SOURCE_URL` | HTTPS source URL sent with the conversion |

Disabled or incomplete configuration records a skipped conversion with a bounded reason code and
performs no provider call. Configuration validation never logs credential values.

## Delivery state machine

```text
queued -> delivering -> delivered
                    -> retry_wait -> delivering
                    -> permanent_failure
queued -> skipped
```

Workers claim rows using `FOR UPDATE SKIP LOCKED` and a renewable lease. Network failures, HTTP
408, HTTP 429 and HTTP 5xx responses use a bounded `1m -> 5m -> 15m -> 1h -> 4h` schedule. The
sixth failed attempt becomes permanent. Other 4xx responses, invalid timestamps and invalid
configuration do not retry automatically.

A crash after provider acceptance can cause a retry, but the retry uses the same provider event ID.
Provider-side event-ID deduplication therefore makes the external effect idempotent while the local
outbox remains at-least-once.

The client follows redirects never, limits response reads, uses a request timeout, and persists only
an error category, HTTP status and a sanitized message of at most 1,000 characters. Authorization
headers, customer identifiers and complete provider responses are never logged or stored.

## Operations

The authenticated operations API exposes only payload-free conversion summaries. Health output
includes queued, delivering, retry-wait, delivered, skipped and permanent-failure counts plus the
oldest due age.

An operator can submit an audited `replay_openai_ads` recovery command with a stable event ID and a
reason. Replay is accepted only for skipped or permanent-failure rows, clears bounded diagnostics,
preserves the stable event ID, and wakes the normal delivery worker. Active or delivered rows cannot
be replayed.

## Rollout

1. Apply the paired migration and deploy with `OPENAI_ADS_ENABLED=false`.
2. Configure the allowed store, endpoint/version, pixel ID and source URL.
3. Add `OPENAI_ADS_CONVERSIONS_API_KEY` as a Secret Manager-backed Cloud Run variable.
4. Enable the integration for the allowed store and inspect health metrics.
5. Roll back by setting `OPENAI_ADS_ENABLED=false`; queued rows remain durable for investigation.

## Acceptance criteria

- Duplicate paid webhooks and reruns create one conversion.
- Two workers cannot claim the same conversion concurrently.
- A crash after provider success retries with the identical provider event ID.
- HTTP 400 becomes a permanent failure without an automatic retry.
- HTTP 408, HTTP 429 and HTTP 5xx retry on the documented bounded schedule.
- The sixth failed attempt becomes permanent.
- Disabled, incomplete or disallowed-store configuration performs no external call and records why.
- Logs, rows, health output and operations views contain no credential or customer payload.
- Manual replay is authenticated, audited, idempotent and cannot replay active or delivered work.
