# Fulfillment action ledger and direct D365 reconciliation

Reference: Prenetics/spock-store `develop` at `2c263e8` (2026-10-27),
`fulfilmentidempotency.ts`, `salesorder/gps.ts`, `fulfilment.ts`, and
`dynamicsreconciliation.ts`.

## Protected provider boundaries

All callers of `gps.createOutboundOrder` and `dynamics.createFulfilment` now reserve
PostgreSQL records before making a live request. This covers order/subscription
creation, backorder retries, GPS polling/recovery, Shopify fulfillment events,
and return packing-slip posting. It does not extend the ledger to unrelated
provider operations such as inventory updates, sales-header creation, payment
posting, or cancellation. Dry runs do not reserve production action identities.

The database primary key protects each provider / endpoint-and-company-or-warehouse /
source order / source line / action identity. GPS source lines are SKUs in its
aggregated outbound payload; D365 lines are InventoryLotIds. D365 always requires
a stable fulfillment/refund ID. Tracking numbers are persisted as lookup aliases
for GPS and Shopify representations of that shipment; adding or correcting tracking
never replaces its original action identity. Alias bindings are immutable and
conflicting histories are blocked. Separate untracked events cannot be recognized
as the same shipment without a shared identity. Never use an execution ID or
wall-clock timestamp as the action identity.

A transaction reserves every line in a batch under an order-scoped advisory lock.
The transaction commits before the HTTP request. There is no provider request
while holding a database transaction. A request fingerprint detects conflicting
replays; raw GPS addresses, credentials, and request payloads are not stored in
the ledger. D365 tracking is excluded from its logical request fingerprint, so
tracking corrections replay the accepted result without another shipment POST;
quantities, line sets, dimensions and shipment dates still must match. Posting
dates come from immutable refund/fulfillment source timestamps; missing or invalid
timestamps fail closed rather than changing on a later retry. Replaying
does not update tracking at D365. GPS stores its order identifier and accepted
shipping channel; D365 stores the minimal THK result
needed by existing invoice checks. Results are committed before returning.

| State | Retry behavior |
| --- | --- |
| pending | Block, including after a crash; no lease expiry or automatic takeover |
| succeeded | Replay the stored result without another provider call |
| failed | Permit a new fenced attempt after a confirmed rejection |
| uncertain | Block until provider evidence is reviewed |

GPS HTTP failures, transport errors, malformed responses and missing order IDs
are uncertain. Only an explicit stock/channel rejection is retryable; the channel
fallback acquires a new attempt after that rejection, retaining the original
logical request fingerprint. A later retry of the original payload returns the
saved fallback order and its accepted channel. An uncertain fallback still blocks
all automatic retries. D365 401/403 is a confirmed
rejection. Other D365 failures, including partially/fully invoiced and over-quantity
responses, require reconciliation. Those messages no longer synthesize success
or trigger another packing-slip POST. This deliberately trades automatic recovery
for preventing duplicate shipment/invoice operations.

## Investigating blocked actions

Use the restricted database operator connection; the tables are not accessible
to anonymous users or the generic authenticated role.

```sql
SELECT action_key, provider, scope, source_order_id, source_line_id, action_name,
       status, attempts, attempt_id, error_code, updated_at
FROM public.fulfillment_actions
WHERE status IN ('pending', 'uncertain')
ORDER BY updated_at;
```

Check GPS outbound details or D365 packing slips for the exact order, shipment,
line and quantity. Order-level reconciliation alone is NOT enough evidence to
release a line-level action. If acceptance is confirmed, preserve the verified
provider result; if non-execution is confirmed, a reviewed operator change may
mark the entire fenced attempt failed before replay. Record provider evidence
and the change in the operations ticket. Do not delete ledger rows, change the
idempotency identity, or bulk-reset pending/uncertain work. This PR intentionally
adds no public or Hub endpoint that clears these safeguards.

## Direct reconciliation

The existing Shopify-to-PostgreSQL checks remain available. The new independent
function reads Shopify and D365 directly and saves each run in
`public.d365_reconciliation_runs`:

- Paid, refunded and partially refunded non-cancelled orders by order creation
  date versus `SalesOrderHeadersV3.OrderCreationDateTime`.
- Shopify `fulfillment_success` events by event date versus
  `CustPackingSlipTransBiEntities.DeliveryDate`, mapped back to Shopify references
  through D365 sales headers. Older orders fulfilled today are included.
- Both companies `U001` and `H007`, using cross-company OData and strict company
  validation. Results list missing D365 references and missing Shopify references
  per D365 company. Presence in either company satisfies the Shopify-side set.

This is order-reference presence reconciliation, matching Spock's scope. It does
not prove quantities, invoice amounts, expected company routing, every split
segment, or a specific uncertain action's outcome. Provider timestamps on opposite
sides of a UTC boundary can cause a discrepancy and must be investigated.

Daily schedule: 01:30 UTC, previous complete UTC day. The new reader has its own
flag `ENABLE_D365_RECONCILIATION=true`, default disabled. It does not enable D365
writes. Before enabling, confirm the selected Shopify store and D365 environment
are the intended pair and grant their read scopes. No production provider calls
or business writes were made to validate this PR.

Manual event (through the existing authenticated Inngest administration path):

```json
{
  "name": "reconciliation/d365.run",
  "data": { "type": "all", "dateFrom": "2026-10-20", "dateTo": "2026-10-21" }
}
```

`type` may also be `salesorder` or `fulfillment`. Dates are inclusive UTC days;
only complete windows of 1–31 days are accepted. Shopify fulfillment history
older than one year is rejected. `RECONCILIATION_SHOPIFY_API_VERSION` defaults to
`2026-07`; `RECONCILIATION_ORDER_PREFIX` defaults to `IM8-` on both sides. The
queries use Shopify's [BasicEvent fulfillment_success contract](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/events).

Every provider page must succeed. Missing headers, invalid timestamps, malformed
pages and repeated cursors fail the run; they are never converted into an empty
successful comparison. D365 pagination is restricted to HTTPS on the configured
origin/entity and does not follow HTTP redirects. Failed attempts have a retained
run ID and safe error category; interrupted attempts remain `running` for inspection.

## Deployment and tests

Apply additive migrations 9–16 before deploying this revision. They separate
storage, indexes and runtime grants; rollback is for disposable tests only.
The prior application remains compatible with the expanded schema.

CI runs the real PostgreSQL ledger suite using `FULFILLMENT_TEST_DATABASE_URL`.
Coverage includes concurrency, replay, confirmed rejection, timeout, abandoned
pending work, completion persistence failure, overlapping batches, provider
boundary retries, direct company queries, pagination, and failed-run history.
Real-database regression tests also cover tracking addition/correction/removal,
cross-source aliases and their conflicts, concurrent aliases, GPS fallback replay,
and uncertain fallback outcomes. No live GPS or D365 requests are needed.

Slack is held independently: `SLACK_PUBLISH_ENABLED=false` on Battle Bus and
`SLACK_DELIVERY=disabled` on the notification service. Keep both disabled until
[ITSDA-8367](https://prenetics.atlassian.net/servicedesk/customer/portal/9/ITSDA-8367)
is approved. This PR does not enable either control.
