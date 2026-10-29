# Backorder recovery and lossless lifecycle scheduling

This document describes PR 2 of the Spock Store replacement sequence. It removes the path where
one `backorder/retry` event could both wake an existing automatic workflow and start another
recovery run, and it removes Inngest rate limits that could discard valid lifecycle events.

## Backorder execution contract

- `process-backorder` consumes only `backorder/created`. When automatic recovery is enabled, it
  uses durable sleeps between bounded attempts.
- `process-backorder-retry` consumes only `backorder/retry`. One event durably waits for an active
  order lease, then performs exactly one recovery attempt; it never wakes the automatic worker.
- Both workers retain per-store/per-order Inngest concurrency and acquire the same PostgreSQL
  order lease before dispatching or executing recovery work.
- A lease is identified by the canonical Shopify store and Shopify order ID. Acquisition is
  atomic; a different worker cannot replace a live lease.
- Lease ownership includes the exact token, stable operation key and worker identity. Every
  provider mutation renews or reacquires that same ownership, so Inngest step replay cannot create
  a second owner or contend with its own released lease.
- The first lease release requires the exact token. Replaying the same release is idempotent only
  while its retained operation key and owner still match; it cannot release a newer active owner.
  A crashed worker becomes recoverable after the bounded expiry instead of leaving the order
  permanently locked. A competing event sleeps durably until that expiry rather than consuming
  generic retries or discarding the requested attempt.
- Manual and automatic replay events use deterministic event IDs derived from the source event and
  attempt number.
- Segmented order recovery uses the same lease and continues to validate fresh Shopify
  eligibility while renewing ownership before provider work.
- `BACKORDER_RETRY_ENABLED=false` stops both automatic and manual mutation paths before credentials,
  database access or provider work. A manual resolution event also cancels a sleeping automatic
  recovery run for the same order and Shopify store.
- Every `backorder/created`, `backorder/retry` and `backorder/resolved` event carries the canonical
  Shopify `myshopify.com` domain. A source-level contract test prevents producers from omitting the
  store or using an unresolved alias.
- Runtime validation also fails closed before lease, database or provider work when an external or
  legacy event has a missing, malformed or unknown store. Reissue already-scheduled legacy events
  through Battle Hub with the canonical domain; they are never allowed to fall back to the active
  configured store.

The lease duration is configured with `BACKORDER_RECOVERY_LEASE_SECONDS`. The default is 600
seconds and accepted values are clamped to 60–3,600 seconds. The default exceeds the Cloud Run
request timeout so an active request cannot normally lose its lease.

## Lossless lifecycle scheduling

Cancellation, refund, Shopify fulfillment, GPS fulfillment, order creation and subscription
renewal functions do not use Inngest `rateLimit`. A rate limit can discard events after the limit
is reached, which is not acceptable for required business work.

These functions retain:

- Stable idempotency expressions for duplicate delivery.
- Concurrency limits for active-work ceilings and order serialization.
- Throttles for provider pacing.
- Durable retries and provider-action ledgers for recovery.

The contract test at `tests/integration/lossless-lifecycle-scheduling.test.ts` prevents a lossy
rate limit from being reintroduced to these workflows.

## Deployment and rollback

1. Apply migration `000047_create_backorder_recovery_leases` before deploying the runtime.
2. Deploy the runtime and confirm both backorder functions are registered in Inngest.
3. Keep `BACKORDER_AUTO_RETRY_ENABLED` at its existing value; this change does not enable automatic
   recovery by itself.
4. Keep `BACKORDER_RETRY_ENABLED=true` only in environments where recovery is approved. Set it to
   `false` for an immediate runtime kill switch.
5. Verify manual retry, duplicate retry, busy-lease deferral and concurrent automatic/manual retry
   scenarios in the development environment before production activation.
6. Inspect already-scheduled backorder events. Reissue any event that lacks the canonical store
   through Battle Hub after deployment; the new runtime rejects it non-retriably and without side
   effects.
7. To roll back, restore the previous runtime first. Drop migration 47 only after no new runtime
   revision can acquire leases.

The lease table contains operational identifiers only. It does not store order payloads, customer
data, addresses, provider credentials or webhook signatures. Client-facing database roles have no
access to it.

## Required evidence

- Migration up/down/up validation succeeds.
- Concurrent lease acquisition permits exactly one owner.
- An incorrect token cannot renew or release another worker's lease.
- Repeating a committed release succeeds for the same operation, while a stale release cannot
  clear a newer active owner.
- The same replay-stable owner can renew or reacquire its lease after a durable step replay.
- A completed segmented recovery does not reacquire its lease when Inngest replays completed steps.
- An expired lease can be reclaimed.
- A busy lease causes a durable wait and later acquisition, not a lost retry event.
- One manual retry event produces one provider/replay attempt.
- Automatic recovery does not consume `backorder/retry` events.
- Automatic cancellation matches both the order ID and canonical store, including producer-shaped
  events, without cancelling the same numeric order ID in a different store.
- The global recovery kill switch prevents both automatic and manual provider work.
- Lifecycle workflow tests confirm there are no `rateLimit` options.
