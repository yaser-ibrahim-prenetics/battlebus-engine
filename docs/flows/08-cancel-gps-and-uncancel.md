# Flow 8: Cancellation Orchestration (GPS + Shopify Uncancel Safeguard)

## Overview

This flow defines what happens when an order is cancelled from:

- Shopify (`orders/cancelled` webhook), or
- Battle Hub (`POST /api/actions/cancel`).

For GPS orders, Battle Bus now calls the GPS OMS cancel API and waits for terminal cancel status.
If GPS cancellation fails because the order is already shipped/in-flight, Battle Bus restores the Shopify order (uncancel) to keep system state aligned with warehouse reality.

## Entry Points

### 1) Shopify-driven cancellation

1. Shopify sends `orders/cancelled` webhook to `POST /api/webhooks/shopify`.
2. Battle Bus emits `shopify/order.cancelled`.
3. `process-order-cancellation` handles GPS/D365/Shopify safeguard logic.

### 2) Battle Hub-driven cancellation

1. Hub calls `POST /api/actions/cancel`.
2. Route cancels the order in Shopify first.
3. Route emits both:
   - `action/order.cancel` (UI/action tracking), and
   - `shopify/order.cancelled` (canonical cancellation processing).
4. `process-order-cancellation` runs same GPS/D365/Shopify safeguard logic.

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
3. Return structured `success/message` result to the cancellation function.

## Warehouse/Order Eligibility

`process-order-cancellation` only calls GPS cancel when all are true:

- GPS sync feature is enabled.
- Shopify GPS metafield exists on the order (`battle_bus.gps_order`).
- Metafield warehouse is one of:
  - `GPS Warehouse`
  - `GPS UK Warehouse`

If not eligible, GPS cancel is skipped cleanly.

## Shopify Uncancel Safeguard

When GPS cancel is not successful (typically already shipped):

1. Battle Bus calls Shopify `POST /orders/{id}/open.json` through `uncancelOrder()`.
2. Order is restored in Shopify.
3. Warning is sent for manual review (GPS channel).
4. Inngest result marks the cancellation as `reverted`/manual path, not a normal success.

This prevents a false-cancelled state in Shopify when physical fulfillment is already underway.

## D365 Handling

- If GPS cancellation succeeds (or is skipped where appropriate), D365 cancellation path runs.
- If GPS cancellation fails and Shopify is uncancelled, flow moves to manual/reverted handling path.

## Config / Environment Variables

### OMS cancel polling controls

- `OMS_CANCEL_STATUS_POLL_ATTEMPTS` (default: `8`)
- `OMS_CANCEL_STATUS_POLL_INTERVAL_MS` (default: `3000`)

### Existing OMS pacing/retry controls (also used)

- `OMS_CLIENT_MIN_INTERVAL_MS`
- `OMS_CLIENT_MAX_RETRIES`
- `OMS_CLIENT_RETRY_BASE_MS`

## Events and Idempotency Notes

- Canonical cancellation processing is on `shopify/order.cancelled` with idempotency keyed by `shopifyOrderId`.
- Hub action route emits canonical event ID format:
  - `shopify-order-cancelled-{shopifyOrderId}`
- Repeated cancels for the same order remain idempotent at function level.

## Operational Outcomes

- Cancel from Shopify or Hub -> same downstream cancellation behavior.
- GPS orders get real OMS cancellation attempts.
- Shipped/in-flight GPS failures no longer leave Shopify wrongly cancelled.
- Action tracking and canonical cancellation processing are both preserved.

