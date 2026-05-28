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
2. Battle Bus emits `shopify/refund.created`.
3. `process-shopify-refund` handles the D365 refund line + return fulfilment (+ opt-in invoice).

### Battle Hub action

1. Hub calls `POST /api/actions/refund`.
2. Route creates refund in Shopify.
3. Route emits `action/order.refund` (tracking only).
4. Shopify fires `refunds/create` webhook → canonical flow above.

## D365 Refund Processing Steps

The `process-shopify-refund` Inngest function performs these steps:

### Step 0: Cross-run Dedupe Guard

Queries `flow_logs` for a prior completed refund emit (`step IN ("refund_line_created", "done")` with `payload->>refundId = <refundId>`). If one already exists, the run exits early with `status: "already_processed"`. This closes the gap left by Inngest event-level idempotency when the same `refundId` arrives via two different event paths (e.g. a Hub-initiated refund racing the Shopify webhook).

### Step 1: Get Shopify Order

Fetches the Shopify order to get the order name (used for D365 lookup).

### Step 2: Get D365 Order

Looks up the D365 sales order by `THK_ShopifyReference` (order name). If not found and D365 sync is enabled, defers via pending actions.

### Step 3: Determine Warehouse Info

Resolves `dataAreaId`, `refundSku`, and `returnConfig` (shipping site/warehouse/location for the return fulfilment).

**Refund SKU source (priority — same as tax/shipping service SKUs):**

1. **Env JSON** — `D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT` / `_PROD` (or generic). Example UAT:
   `{"U001":{"refund":"IM8-SER-000005","shipping":"IM8-SER-000003",...},"H007":{...}}`
2. **Built-in profile map** (`BUILTIN_SERVICE_SKU_BY_PROFILE`) when env is unset.
3. **`warehouse-config.json`** per warehouse when data area is not in the map.

UAT U001 + H007: refund **`IM8-SER-000005`** · shipping **`IM8-SER-000003`** (`000003` is shipping in D365, not refund).

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

Returns `InventoryLotId` for the return fulfilment. Immediately emits a `refund_line_created` flow log so the dedupe guard can short-circuit any duplicate refund events even if this run fails partway through.

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

- **First attempt**: Stored as pending action via `storePendingAction`.
- **Drain replay**: `drain-pending-actions` cron replays with `fromDrain: true`.
- **After drain**: If D365 order still not found, returns `status: "failed"`.

## Currency Handling

Refund amounts are converted to USD before creating the D365 line using the priority order documented in step 4b above.

## Works With All Fulfillment States

- **Unfulfilled orders**: Refund line + return fulfilment.
- **Fulfilled orders (Stord/GPS/manual)**: Same flow — the refund is financial, independent of physical fulfillment status.

## Error Handling

- D365 order not found → deferred (pending action).
- Refund amount is 0 → skipped.
- Return invoice fails (when opt-in is enabled) → non-blocking (Slack alert, function returns success).
- Dry run mode → returns early with `status: "dry_run"`.

## Idempotency

Two layers:

1. **Inngest event-level** — `idempotency: "event.data.refundId"` dedupes retries of the same event within Inngest's window.
2. **Cross-run flow-log guard** — step 0 above queries `flow_logs` for any prior completed refund emit carrying the same `refundId`, so even a second event with the same `refundId` from a different path cannot create a duplicate negative D365 line. This mirrors spock-store's per-line `shopifyLineItemId` check.
