# Flow 7: Fulfillment → D365 Sync

> **Direction:** Shopify / Battle Hub → Battle Bus → Dynamics 365

## Overview

When an order is fulfilled (via Stord, GPS cron, or manual action from Battle Hub), Battle Bus syncs the fulfillment to D365 by creating a packing slip and posting a prepayment. This flow handles all fulfillment sources.

```
┌─────────────┐   orders/fulfilled   ┌─────────────┐   1. Packing slip    ┌───────────────┐
│   Shopify   │ ───────────────────► │  Battle Bus │ ─────────────────► │  Dynamics 365 │
│  (Stord /   │      webhook         │             │   2. Prepayment    │               │
│   Manual)   │                      └─────────────┘                    └───────────────┘
└─────────────┘                             │
                                            │  PayPal tracking sync
┌─────────────┐   Manual fulfill     ┌─────────────┐
│ Battle Hub  │ ───────────────────► │  Battle Bus │ (same D365 path)
└─────────────┘   action route       └─────────────┘
```

## Entry Points

### 1) Shopify webhook (Stord / non-GPS fulfillments)

1. Stord or manual fulfillment creates fulfillment in Shopify.
2. Shopify fires `orders/fulfilled` webhook.
3. Battle Bus emits `shopify/order.fulfilled`.
4. `process-shopify-fulfillment` creates D365 packing slip + prepayment.

### 2) GPS cron sync

1. `cron-gps-sync` detects GPS order shipped (status 3).
2. Creates Shopify fulfillment with GPS tracking.
3. Emits `shopify/order.fulfilled` with `fromGpsSync: true`.
4. `process-shopify-fulfillment` creates D365 packing slip + prepayment.

### 3) Battle Hub manual fulfillment

1. Hub calls `POST /api/actions/fulfillment`.
2. Route creates Shopify fulfillment (fetches GPS tracking if GPS order).
3. Route emits both:
   - `action/order.fulfill` (UI tracking)
   - `shopify/order.fulfilled` with `fromManualFulfillment: true` (D365 sync)
4. `process-shopify-fulfillment` creates D365 packing slip + prepayment.

## GPS Fulfillment Skip Logic

To prevent double D365 processing, GPS-only fulfillments from Shopify webhook echo are skipped:

```
GPS fulfillment event arrives
  ├─ fromGpsSync: true        → Process (cron path)
  ├─ fromManualFulfillment: true → Process (Hub manual path)
  └─ Neither flag              → Skip (webhook echo after cron created fulfillment)
```

## D365 Processing Steps

### Step 1: Get D365 Order

Looks up D365 sales order by `THK_ShopifyReference`. If not found, defers via pending actions.

### Step 2: Process Fulfillments

For each fulfillment in the event:

1. Skip GPS fulfillments (handled separately) and dummy/adjustment fulfillments.
2. Filter out dummy SKUs.
3. Get `lotIdMap` from D365 sales order lines.
4. Call `dynamics.createFulfilment` with:
   - `type: "PackingSlip"`
   - Lines with item numbers, quantities, tracking, and lot IDs.

### Step 3: Post Prepayment

Skipped at fulfillment time — prepayment is posted during order creation (`shopify/order.paid`).

### THK response validation

When THK returns `status: 1`, fulfilment is **success** even if `Message` includes informational warehouse-dimension text (e.g. `Dimension Warehouse is still specified … USOPS-WH04`). That text is stored on the flow log as `thkApiWarning` with `level: warn` (fulfilment still completes). The same applies on deposit orders: warehouse/site dimension messages never fail fulfilment or queue `d365_fulfilment_incomplete` — only explicit invoice-failure phrases do.

### Step 4: PayPal Tracking Sync (non-blocking)

If PayPal transactions exist on the order, pushes tracking info to PayPal for seller protection.

## GPS Manual Fulfillment

GPS API does not have an explicit "fulfill" or "mark shipped" endpoint. GPS fulfillment is entirely warehouse-driven — when the warehouse ships, GPS status changes to 3 (shipped), detected by `cron-gps-sync`.

For manual GPS fulfillment from Battle Hub:

1. The Hub action route checks GPS order status (must be 3 = shipped).
2. Fetches tracking number and carrier from GPS API.
3. Creates Shopify fulfillment with GPS tracking info.
4. Emits canonical event with `fromManualFulfillment: true`.
5. D365 sync runs (packing slip + prepayment).

## D365 API Calls

| Step         | D365 Endpoint                                        | Purpose                                    |
| ------------ | ---------------------------------------------------- | ------------------------------------------ |
| Packing slip | `POST .../THK_APISyncService_Shopify/fulfilment`     | Creates packing slip (type: "PackingSlip") |
| Prepayment   | `POST .../THK_APISyncService_Shopify/PostPrepayment` | Posts prepayment / invoice                 |

## Deferred Fulfillments

If the D365 order is not yet created when the fulfillment arrives:

- **First attempt**: Stored as pending action via `storePendingAction`.
- **Drain replay**: `drain-pending-actions` cron replays with `fromDrain: true`.
- **After drain**: If D365 order still not found, returns `status: "failed"` with Slack alert.

## Error Handling

- D365 order not found → deferred (pending action).
- D365 packing slip fails → logged, Slack alert to dynamics/stord channel.
- D365 prepayment fails → logged, Slack alert (non-blocking).
- PayPal sync fails → logged (never fails the function).

## Summary

| Source                             | GPS Check        | D365 Packing Slip | D365 Prepayment | PayPal Sync |
| ---------------------------------- | ---------------- | ----------------- | --------------- | ----------- |
| Stord webhook                      | N/A (non-GPS)    | Yes               | Yes             | Yes         |
| GPS cron (fromGpsSync)             | Already shipped  | Yes               | Yes             | Yes         |
| Hub manual (fromManualFulfillment) | Must be status 3 | Yes               | Yes             | Yes         |
| Webhook echo (no flag)             | Skipped          | -                 | -               | -           |
