# Flow 5: Refunds

> **Direction:** Shopify → Battle Bus → Dynamics 365

## Overview

When a Shopify refund is created, Battle Bus processes it by creating a negative sales order line in D365, posting a return fulfilment, and invoicing the return to generate a credit note. This flow works for both fulfilled and unfulfilled orders.

```
┌─────────────┐   refunds/create    ┌─────────────┐   1. Create refund line     ┌───────────────┐
│   Shopify   │ ──────────────────► │  Battle Bus │   2. Post return fulfilment │  Dynamics 365 │
└─────────────┘     webhook         │             │ ──────────────────────────► │               │
                                    │             │   3. Post return invoice    │  Credit Note  │
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
3. `process-shopify-refund` handles D365 refund line + return fulfilment + invoice.

### Battle Hub action

1. Hub calls `POST /api/actions/refund`.
2. Route creates refund in Shopify.
3. Route emits `action/order.refund` (tracking only).
4. Shopify fires `refunds/create` webhook → canonical flow above.

## D365 Refund Processing Steps

The `process-shopify-refund` Inngest function performs these steps:

### Step 1: Get Shopify Order

Fetches the Shopify order to get the order name (used for D365 lookup).

### Step 2: Get D365 Order

Looks up the D365 sales order by `THK_ShopifyReference` (order name). If not found and D365 sync is enabled, defers via pending actions.

### Step 3: Determine Warehouse Info

Resolves `dataAreaId`, `refundSku`, and `returnConfig` (shipping site/warehouse/location for the return fulfilment) from the warehouse configuration.

### Step 4: Calculate Refund Amount

Sums successful refund transactions from the Shopify refund payload. Converts to USD if the order currency differs (using Shopify transaction exchange rates or static fallback rates).

### Step 5: Create Negative Sales Order Line

Calls `dynamics.createSalesOrderLine` with:
- `quantity: -1`
- `price: refundAmountUsd`
- `itemNumber: refundSku` (data-area-specific refund item)

Returns `InventoryLotId` for the return fulfilment.

### Step 6: Post Return Fulfilment

Calls `dynamics.createFulfilment` with:
- `type: "return"`
- `lines[].lotId: InventoryLotId` from step 5
- Return site/warehouse/location from warehouse config

### Step 7: Post Return Invoice (Credit Note)

Calls `dynamics.postReturnOrderInvoice` to generate a D365 credit note:
- `salesOrderNumber`
- `dataAreaId`
- `invoiceDate: today`

Returns `creditNoteNumber`. This step is non-blocking — if it fails, a Slack alert is sent but the function still returns success (the refund line and return fulfilment are already posted).

### Step 8: Notify CS Platform

Sends refund event with amount, type (full/partial), and financial status.

## D365 API Calls

| Step | D365 Endpoint | Purpose |
|---|---|---|
| Create refund line | `POST /data/SalesOrderLines` | Negative qty line with refund SKU |
| Post return fulfilment | `POST .../THK_APISyncService_Shopify/fulfilment` | Posts the return (type: "return") |
| Post return invoice | `POST .../THK_SalesOrderService/postReturnOrderInvoice` | Generates credit note |

## Deferred Refunds

If the D365 order is not yet created when the refund arrives:

- **First attempt**: Stored as pending action via `storePendingAction`.
- **Drain replay**: `drain-pending-actions` cron replays with `fromDrain: true`.
- **After drain**: If D365 order still not found, returns `status: "failed"`.

## Currency Handling

Refund amounts are converted to USD before creating the D365 line:

1. Extract exchange rate from Shopify transaction receipt.
2. Fall back to static rates if extraction fails.
3. Log the conversion for audit.

## Works With All Fulfillment States

- **Unfulfilled orders**: Refund line + return fulfilment + invoice.
- **Fulfilled orders (Stord/GPS/manual)**: Same flow — the refund is financial, independent of physical fulfillment status.

## Error Handling

- D365 order not found → deferred (pending action).
- Refund amount is 0 → skipped.
- Return invoice fails → non-blocking (Slack alert, function returns success).
- Dry run mode → returns early with `status: "dry_run"`.

## Idempotency

Keyed by `refundId` — each Shopify refund is processed exactly once.
