# Durable Meta channel-lift delivery

## Purpose

Battle Bus replaces Spock Store's `meta.channel-lift` task with a durable,
privacy-minimising workflow. The workflow reads the previous completed reporting
day from Triple Whale, validates attributed Shopify orders, and sends eligible
purchase events to Meta Conversions API without weakening Battle Bus's queue,
concurrency, idempotency, or operational-evidence guarantees.

Europa is out of scope.

## Functional contract

### Scheduling and run identity

- Schedule the daily request at `00:35 America/New_York` for the previous local
  reporting date. Daylight-saving changes must preserve the local wall-clock
  schedule.
- Derive a stable run identity from reporting date and mode (`dry_run` or
  `live`). A reporting date may have at most one active run and one successful
  live delivery.
- Accept authenticated manual requests for one date or an inclusive bounded
  date range. Live delivery requires an explicit `live` flag; the safe default
  is dry-run.
- Reject future dates, invalid ranges, and ranges longer than 31 days.

### Triple Whale extraction

- Use the configured, approved Shopify shop identifier and a fixed attribution
  model/window.
- Read aggregate row, order, and order/channel-pair counts before fetching data.
- Fetch deterministic, bounded pages and validate the response shape, reporting
  date, order IDs, channel values, and page termination.
- Reconcile fetched row/order/pair counts with the aggregate query. Fail closed
  on missing pages, duplicate-page drift, or any count mismatch.
- Use a version-controlled channel mapping. The initial delivery allowlist is
  `Klaviyo`; unknown mappings are excluded and counted, never guessed.

### Shopify eligibility

- Fetch only the order IDs returned by the reconciled attribution snapshot, in
  bounded GraphQL batches.
- Require an exact requested-ID match, paid financial status, non-test order,
  no cancellation, a valid ISO currency, a timezone-qualified purchase time
  within Meta's accepted age, an approved HTTPS source URL, and at least one
  approved identity (`email` or customer external ID).
- Hash normalised customer fields with SHA-256 before creating Meta events.
  Do not log or persist raw customer identity data or full provider responses.
- Record privacy-safe exclusion counts by reason.

### Meta delivery

- Derive `event_id` deterministically from shop, Shopify order ID, and mapped
  event name. Replaying the same date must reuse the same IDs.
- Send at most 500 events per request, sequentially within a reporting date.
- Apply bounded request timeouts and retry network failures, HTTP 429, and 5xx
  responses. Treat other 4xx responses as permanent provider rejection.
- Require Meta's `events_received` to equal the submitted batch size. Partial or
  ambiguous receipts fail closed.
- Checkpoint each batch in its own Inngest step. If acceptance is uncertain, a
  retry resends identical event IDs so Meta can deduplicate the attempt.
- Dry-run mode performs no Meta write.

### Persistence and operations

- Persist reporting date, mode, status, attempts, source and eligible counts,
  exclusion counts, batch/attempted/delivered counts, deterministic configuration
  and snapshot digests, safe error codes, and timestamps.
- Never persist access tokens, raw Triple Whale rows, Shopify responses, email,
  phone, IP address, cookie values, or the Meta `user_data` payload.
- Expose a payload-free Battle Hub view and an authenticated operations view.
- Keep provider credentials in GCP Secret Manager. Runtime configuration must
  fail closed when live mode is enabled without complete approved settings.

## Configuration

Secrets:

- `TRIPLE_WHALE_API_KEY`
- `META_CONVERSIONS_ACCESS_TOKEN`

Non-secret settings:

- `CHANNEL_LIFT_ENABLED` (registration/processing gate; default `false`)
- `CHANNEL_LIFT_SEND_ENABLED` (live-send kill switch; default `false`)
- `CHANNEL_LIFT_TRIPLE_WHALE_SHOP_ID`
- `CHANNEL_LIFT_META_DATASET_ID`
- `CHANNEL_LIFT_SOURCE_URL`
- `CHANNEL_LIFT_PAGE_SIZE` (1-50,000; default 20,000)
- `CHANNEL_LIFT_MAX_EVENT_AGE_SECONDS` (default 604,800)

## Rollout

1. Apply the additive channel-lift evidence migration.
2. Add both credentials as pinned Secret Manager bindings and deploy with both
   feature flags disabled.
3. Enable `CHANNEL_LIFT_ENABLED` with live sending disabled. Run at least seven
   daily dry-runs and reconcile counts against Spock Store.
4. Execute a one-day canary with `CHANNEL_LIFT_SEND_ENABLED=true`, verify Meta
   receipt counts and replay deduplication, then expand.
5. Retain the kill switch and Spock rollback path until the agreed observation
   window is complete.

## Acceptance criteria

- DST tests show the cron remains at `00:35 America/New_York`.
- Triple Whale count or period mismatches prevent Shopify reads and Meta writes.
- Unknown channels and ineligible Shopify orders produce bounded safe counts.
- Dry-run creates zero Meta requests.
- A partial Meta receipt fails the run.
- A replay uses the exact same deterministic event IDs and cannot create a new
  logical conversion.
- Parallel requests for one date cannot run concurrently.
- Operational evidence contains no customer identities or provider secrets.
- Lint, unit tests, migration validation, dependency audit, and production build
  pass before merge.
