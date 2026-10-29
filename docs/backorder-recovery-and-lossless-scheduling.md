# Backorder recovery and lossless lifecycle scheduling

This document describes PR 2 of the Spock Store replacement sequence. It removes the path where
one `backorder/retry` event could both wake an existing automatic workflow and start another
recovery run, and it removes Inngest rate limits that could discard valid lifecycle events.

## Backorder execution contract

- `process-backorder` consumes only `backorder/created`. When automatic recovery is enabled, it
  uses durable sleeps between bounded attempts.
- `process-backorder-retry` consumes only `backorder/retry`. One event performs one immediate
  recovery attempt; it never wakes the automatic worker.
- Both workers retain per-store/per-order Inngest concurrency and acquire the same PostgreSQL
  order lease before dispatching or executing recovery work.
- A lease is identified by the canonical Shopify store and Shopify order ID. Acquisition is
  atomic; a different worker cannot replace a live lease.
- Lease release requires the exact token. A crashed worker becomes recoverable after the bounded
  expiry instead of leaving the order permanently locked.
- Manual and automatic replay events use deterministic event IDs derived from the source event and
  attempt number. GPS mutations also remain protected by the fulfillment-action ledger.
- Segmented order recovery uses the same lease and continues to validate fresh Shopify
  eligibility before provider work.

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
4. Verify manual retry, duplicate retry and concurrent automatic/manual retry scenarios in the
   development environment before production activation.
5. To roll back, restore the previous runtime first. Drop migration 47 only after no new runtime
   revision can acquire leases.

The lease table contains operational identifiers only. It does not store order payloads, customer
data, addresses, provider credentials or webhook signatures. Client-facing database roles have no
access to it.

## Required evidence

- Migration up/down/up validation succeeds.
- Concurrent lease acquisition permits exactly one owner.
- An incorrect token cannot release another worker's lease.
- An expired lease can be reclaimed.
- One manual retry event produces one provider/replay attempt.
- Automatic recovery does not consume `backorder/retry` events.
- Lifecycle workflow tests confirm there are no `rateLimit` options.
