# Flow 5: Refunds

> **Direction:** Shopify → Battle Bus → Dynamics 365

## Overview

When a Shopify refund is created, Battle Bus processes it by creating a negative sales order line in D365 and posting a return fulfilment on the same sales order. In the standard THK tenant the return fulfilment is what generates the credit note — mirroring the spock-store reference flow — so the explicit `postReturnOrderInvoice` call is now opt-in (see feature flag below).

```
┌─────────────┐   refunds/create    ┌─────────────┐   1. Create refund line     ┌───────────────┐
│   Shopify   │ ──────────────────► │  Battle Bus │   2. Post return fulfilment │  Dynamics 365 │
└─────────────┘     webhook         │             │ ──────────────────────────► │               │
                                    │             │   (credit note auto-posted) │  Credit Note  │
                                    └─────────────┘                             └───────────────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │ CS Platform │
                                    └─────────────┘
```

## Trigger Events

- Customer requests refund through Shopify
- Admin processes refund in Shopify
- Hub user creates refund via `POST /api/actions/refund`
- Shopify fires `refunds/create` webhook

## Entry Points

### Shopify webhook

1. Shopify fires `refunds/create` webhook.
2. When Loop Returns is enabled, Battle Bus checks Shopify order timeline events. If Loop authored the refund, the webhook is **acknowledged but not forwarded** to Inngest (Loop `return.closed` already emitted `shopify/refund.created`).
3. Otherwise Battle Bus emits `shopify/refund.created` with `refundInitiator: shopify_webhook`.
4. `process-shopify-refund` handles the D365 refund line + return fulfilment (+ opt-in invoice).

### Loop Returns webhook

1. Loop fires `return.closed` with a positive refund total.
2. Battle Bus emits `shopify/refund.created` with `refundInitiator: loop_return_closed` (synthetic REST-shaped payload; `refundId` is the Loop return id).
3. Shopify then fires its own `refunds/create` for the same money movement — suppressed at webhook ingress (step 2 above) so only **one** Inngest run is created.
4. `process-shopify-refund` still contains an in-function Loop duplicate check as fallback for replays or manual event sends.

### Battle Hub action

1. Hub calls `POST /api/actions/refund`.
2. Route creates refund in Shopify.
3. Route emits `action/order.refund` (tracking only).
4. Shopify fires `refunds/create` webhook → canonical flow above.

## D365 Refund Processing Steps

The `process-shopify-refund` Inngest function performs these steps:

### Step 0: Database Refund Reservation

Atomically reserves `refund_id` in `public.refund_operations`. The primary key
allows only one Inngest run to own the D365 side effects, even when the same
refund arrives concurrently through multiple event paths. Existing completed,
processing, or line-created operations exit before the D365 lookup. Recovery
events must also present the database dispatch lease attached by
`recover-pending-refunds`.

### Step 1: Get Shopify Order

Fetches the Shopify order to get the order name (used for D365 lookup).

### Step 2: Get D365 Order

Looks up the D365 sales order by `THK_ShopifyReference` (order name). If it is
not visible yet, the owned refund operation moves to `awaiting_order` with
bounded exponential backoff.

### Step 3: Determine Warehouse Info

Resolves `dataAreaId`, `refundSku`, and `returnConfig` (shipping site/warehouse/location for the return fulfilment).

**Refund SKU source (same as tax/shipping service SKUs):**

Service SKUs (tax/shipping/refund) are a **hard-coded constant map** in code — `SERVICE_SKUS_BY_PROFILE` in `src/lib/helpers/warehouse.ts` — keyed by profile and `dataAreaId` (U001 / H007). There are **no SKU env vars**; SKU changes are a code change (reviewed + test-locked).

**Profile:** `SHOPIFY_STORE_MODE=test` → UAT · `SHOPIFY_STORE_MODE=production` → PROD (falls back to `NODE_ENV` when unset).

| Profile            | tax                                               | refund               | shipping         |
| ------------------ | ------------------------------------------------- | -------------------- | ---------------- |
| UAT (U001 & H007)  | `IM8-SER-000004` (U001) / `IM8-SER-000001` (H007) | **`IM8-SER-000005`** | `IM8-SER-000003` |
| PROD (U001 & H007) | `IM8-SER-000001`                                  | **`IM8-SER-000003`** | `IM8-SER-000002` |

In UAT, `IM8-SER-000003` is the **shipping** item — never the refund item. Because SKUs are code, a wrong value can't be introduced through a runtime environment edit.

Return sites still come from `warehouse-config.json` for the fulfillment warehouse profile.

### Step 4: Calculate Refund Amount

Sums successful refund transactions (`kind="refund"`, `status="success"`) from the Shopify refund payload, falling back to `refund_line_items` subtotal + tax when the gateway omits transaction rows.

### Step 4b: Convert to USD

Uses **presentment currency** (refund transaction currency → `order.presentment_currency` → `order.currency`), not shop `currency` alone. IM8’s shop currency is often USD while UK/EU customers pay and refund in GBP/EUR; skipping conversion when `order.currency === "USD"` was incorrect.

Priority order for the FX rate used when converting a non-USD refund to the D365 currency (USD):

1. **Refund receipt** — `refund.transactions[i].receipt.balance_transaction.exchange_rate`. This is the actual rate Stripe/Shopify applied to the refund and matches spock-store's `convertToUsd` behaviour.
2. **Pair-based extraction** — derive a rate from two order transactions in different currencies (existing fallback).
3. **Static fallback** — hand-maintained table in `inngest/src/lib/helpers/exchange.ts`.

### Step 5: Create Negative Sales Order Line

Calls `dynamics.createSalesOrderLine` with:

- `quantity: -1`
- `price: refundAmountUsd`
- `itemNumber: refundSku` (data-area-specific refund item)

Returns `InventoryLotId` for the return fulfilment and records the operation as
`line_created` while retaining the same database claim. Before the POST, the
operation moves to `creating_line` and the line receives a deterministic,
hashed `LineDescription` marker. If the POST succeeds but its database
acknowledgement fails, retries search D365 for that marker and reconcile the lot
ID instead of issuing another POST. Other events carrying the same refund ID
cannot create another negative line.

### Step 6: Post Return Fulfilment

Calls `dynamics.createFulfilment` with:

- `type: "return"`
- `lines[].lotId: InventoryLotId` from step 5
- Return site/warehouse/location from warehouse config

In the standard THK tenant this call is what causes D365 to post the credit note.

### Step 7: Post Return Invoice (opt-in)

Disabled by default. Enable with env var `ENABLE_RETURN_INVOICE_POSTING=true` (wired via `config.features.enableReturnInvoicePosting`). When enabled, calls `dynamics.postReturnOrderInvoice` and returns the `creditNoteNumber`. When disabled — the default — this step logs "credit note expected via return fulfilment" and exits with `status: "skipped"`, matching spock-store's behaviour.

### Step 8: Notify CS Platform

Sends refund event with amount, type (full/partial), and financial status.

## D365 API Calls

| Step                         | D365 Endpoint                                           | Purpose                                                   |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Create refund line           | `POST /data/SalesOrderLines`                            | Negative qty line with refund SKU                         |
| Post return fulfilment       | `POST .../THK_APISyncService_Shopify/fulfilment`        | Posts the return (type: "return") — generates credit note |
| Post return invoice (opt-in) | `POST .../THK_SalesOrderService/postReturnOrderInvoice` | Only called when `ENABLE_RETURN_INVOICE_POSTING=true`     |

## Deferred Refunds

If the D365 order is not yet created when the refund arrives:

- **First attempt**: The refund operation moves to `awaiting_order` and retains
  its event payload in private Cloud SQL storage.
- **Recovery dispatch**: `recover-pending-refunds` claims due rows with
  `FOR UPDATE SKIP LOCKED`, attaches a lease token, and emits a stable event ID.
- **Still missing**: The handler returns the row to `awaiting_order` with
  exponential backoff capped at one hour.
- **Order visible**: The leased recovery run performs the D365 refund and marks
  the operation `completed`; the database scrubs the retained event payload.

Dispatch leases are single-use: accepting a lease atomically moves the row out
of `dispatching`, so replaying the same token cannot start another worker.
Expired active states are recoverable. A `creating_line` recovery only performs
D365 marker reconciliation and never blindly repeats an ambiguous POST. After
12 database recovery attempts, the row moves to `dead_letter`, its retained
event payload is scrubbed, and its minimal error and timing metadata remain
available for operator intervention.

## Currency Handling

Refund amounts are converted to USD before creating the D365 line using the priority order documented in step 4b above.

## Works With All Fulfillment States

- **Unfulfilled orders**: Refund line + return fulfilment.
- **Fulfilled orders (Stord/GPS/manual)**: Same flow — the refund is financial, independent of physical fulfillment status.

## Error Handling

- D365 order not found → deferred in `refund_operations` for automatic recovery.
- Refund amount is 0 → skipped.
- Return invoice fails (when opt-in is enabled) → non-blocking (Slack alert, function returns success).
- Dry run mode → returns early with `status: "dry_run"`.

## Idempotency and ownership

The refund migration series (`000009` through `000013`) makes PostgreSQL
authoritative. It separates the ledger schema, recovery indexes, lifecycle
triggers, and access controls, then backfills completed refund IDs from the
existing flow log:

1. `refund_id` is the table primary key, so concurrent event paths contend on
   one row rather than racing a diagnostic log lookup.
2. State transitions require the current `claim_token`; stale recovery events
   cannot process the refund.
3. Recovery dispatches use stable IDs derived from the refund ID and database
   attempt number.
4. D365 line creation uses a hashed per-refund marker and a pre-write database
   checkpoint, closing the external-write acknowledgement window.
5. Completion and dead-lettering scrub `event_data` while retaining operational
   audit metadata.
