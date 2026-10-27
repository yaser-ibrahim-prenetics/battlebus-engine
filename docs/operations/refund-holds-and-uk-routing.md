# Refund holds and UK GPS routing

Reference: Spock Store `develop` commit `2c263e8`, `src/component/refund.ts` and
`src/component/salesorder/gps.ts`.

## Refund hold

The `shopify/refund.created` workflow waits before downstream D365 processing when
any refunded line's webhook snapshot is not `fulfilled`. Partial, null, and absent
fulfillment statuses count as unfulfilled. Other unfulfilled lines on the order do
not affect this decision. Amount-only refunds and fully fulfilled refunds proceed
without a hold. A live order becoming fulfilled does not shorten the hold.

The deadline is `processed_at + 24 hours`, falling back to `created_at`. Invalid or
missing timestamps fall back to the database's first-seen time. Timestamps must
include a timezone. An expired deadline proceeds immediately; the hold is never
restarted on replay. This delays accounting/fulfillment processing of an existing
Shopify refund; it does not delay the customer's Shopify payment refund.

PostgreSQL stores the first decision per store, source, and refund ID, including
no-hold decisions. Runtime access permits insert and read only. No customer payload
is stored. Database errors stop the workflow before provider processing. A durable
Inngest sleep releases processing until the fixed deadline; pending-action replays
use the same gate. Dry-run and already-completed refunds preserve their early exits.
Loop's existing amount-only synthetic refunds remain amount-only and use a separate
source namespace.

Apply migrations 17 (storage) and 18 (access) before deploying the application; the
existing GitHub Actions pipeline already runs migrations before rollout. Do not
roll back these tables while waiting runs may resume. Normal code rollback can
resume immediate refund processing, so coordinate rollback with operations.

The workflow emits a `refund_hold` flow event with the deadline and unfulfilled line
count. For recovery, inspect `refund_hold_decisions` and the Inngest run. Retry a
failed run after resolving its dependency failure; do not delete or alter its hold
decision to bypass the deadline. Existing provider-action ledger safeguards still
apply after the wait. In-flight runs which passed this step before deployment are
not retroactively recalled or delayed.

## UK GPS routing

Orders routed to `GPS UK Warehouse` use `RS-RM-UK` by default. A comma-separated
Shopify tag exactly matching `expedited shipping`, ignoring case and surrounding
whitespace, selects `RS-DPDZONE1`. US routing remains `GPS-IM8-STANDARD`.

The shared GPS transformer applies this to normal orders, subscriptions, and
backorders. Already-submitted GPS actions are not resent to change their channel:
the fulfillment ledger will block a changed request that conflicts with a previous
action. Resolve those cases with provider reconciliation, not by clearing the ledger.

## Verification

The test suite covers exact tag matching, UK and US payload channels, immutable
refund deadlines under concurrency, missing dates, expired holds, source/store
isolation, access restrictions, and the actual refund workflow's wait before
provider access. PostgreSQL integration tests run in CI with
`REFUND_HOLD_TEST_DATABASE_URL` pointing to the disposable migration-test database.
