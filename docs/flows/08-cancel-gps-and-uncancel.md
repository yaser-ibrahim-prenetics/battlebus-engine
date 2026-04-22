# Flow 8: Cancellation Orchestration (GPS Cancel + Shopify Uncancel Safeguard)

## Overview

When an order is cancelled, Battle Bus only takes action for GPS orders: it calls the GPS OMS cancel API. No D365 action is performed on cancellation — D365 sales orders are left as-is.

If GPS cancellation fails (order already shipped / in-flight), Battle Bus restores the Shopify order via uncancel to keep system state aligned with warehouse reality.

Non-GPS orders require no downstream action on cancel — the Shopify cancellation itself is sufficient.

## Entry Points

### 1) Shopify-driven cancellation

1. Shopify sends `orders/cancelled` webhook to `POST /api/webhooks/shopify`.
2. Battle Bus emits `shopify/order.cancelled`.
3. `process-order-cancellation` handles GPS cancel + Shopify uncancel safeguard.

### 2) Battle Hub-driven cancellation

1. Hub calls `POST /api/actions/cancel`.
2. Route cancels the order in Shopify first.
3. Route emits both:
   - `action/order.cancel` (UI/action tracking)
   - `shopify/order.cancelled` (canonical cancellation processing)
4. `process-order-cancellation` runs same GPS cancel + uncancel safeguard logic.

## Cancel Flow

```
shopify/order.cancelled
  │
  ├─ GPS order?
  │   ├─ YES → Cancel in GPS (OMS API)
  │   │         ├─ Success → Done (notify CS platform)
  │   │         └─ Failed  → Uncancel Shopify order + Slack alert
  │   │
  │   └─ NO  → No action (notify CS platform)
  │
  └─ GPS metadata not found + GPS sync enabled?
      └─ Defer via pending actions (GPS order not yet created)
```

### What cancellation does NOT do

- **No D365 action**: Sales orders in D365 are not deleted or modified on cancel.
- **No D365 lookup**: The cancel function does not query D365 at all.

## GPS Cancel Logic

Implemented in `src/lib/clients/gps.ts` using OMS APIs:

- `POST /openapi/v1/outboundOrder/cancel`
- `POST /openapi/v1/outboundOrder/selectBizStatus` (polling)

Behavior:

1. Submit cancel request for `outboundOrderNo`.
2. Poll `selectBizStatus` until terminal:
   - `status=1` -> success
   - `status=2` -> failed
   - `status=0` -> still processing (continue polling)
3. Return structured `success/message` result.

## GPS Order Resolution

`process-order-cancellation` resolves the GPS order number using multiple strategies:

1. **Primary**: Shopify GPS metafield (`battle_bus.gps_order`) — contains `gpsOrderId` and `warehouse`.
2. **Legacy fallback**: Raw metafield keys (`gpsorderid`, `gpsukorderid`).
3. **Name fallback**: Uses Shopify order name as outbound order number, trying both US and UK warehouses based on shipping country.

## Shopify Uncancel Safeguard

When GPS cancel fails (typically because the order is already shipped):

1. Battle Bus calls Shopify `POST /orders/{id}/open.json` via `uncancelOrder()`.
2. Order is restored in Shopify.
3. Warning sent to GPS Slack channel for manual review.
4. Function returns `status: "reverted"`.

## Deferred Cancellation

If GPS metadata is not found and GPS sync is enabled, the cancellation is deferred via `storePendingAction`. The `drain-pending-actions` cron will replay it once the GPS order has been created.

## Config / Environment Variables

### OMS cancel polling controls

- `OMS_CANCEL_STATUS_POLL_ATTEMPTS` (default: `8`)
- `OMS_CANCEL_STATUS_POLL_INTERVAL_MS` (default: `3000`)

## Idempotency

- Cancellation processing is keyed by `shopifyOrderId` (idempotent).
- Hub action route uses unique event IDs to avoid collision with Shopify webhook events.
- Repeated cancels for the same order are handled gracefully.

## Summary

| Order Type    | GPS Action         | D365 Action | Shopify Action               |
| ------------- | ------------------ | ----------- | ---------------------------- |
| GPS order     | Cancel via OMS API | None        | Uncancel if GPS cancel fails |
| Non-GPS order | None               | None        | None                         |
