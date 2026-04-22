# Flow 9: Lifecycle Actions Overview (Cancel / Refund / Fulfill)

## Summary

This document provides a unified view of all three order lifecycle actions and their downstream effects on GPS and D365.

## Action Matrix

| Action      | GPS Order                                                            | Non-GPS Order                   |
| ----------- | -------------------------------------------------------------------- | ------------------------------- |
| **Cancel**  | Cancel in GPS OMS; uncancel Shopify if GPS cancel fails              | No action                       |
| **Refund**  | D365: refund line + return fulfilment + return invoice (credit note) | Same D365 flow                  |
| **Fulfill** | D365: packing slip + prepayment (GPS must already be shipped)        | D365: packing slip + prepayment |

## D365 Actions Per Flow

| Flow    | D365 Calls                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------ |
| Cancel  | None                                                                                             |
| Refund  | `createSalesOrderLine` (qty -1) → `createFulfilment` (type: "return") → `postReturnOrderInvoice` |
| Fulfill | `createFulfilment` (type: "PackingSlip") → `createPrepayment`                                    |

## Entry Points

Each lifecycle action can be triggered from Shopify webhooks or Battle Hub actions:

| Action  | Shopify Webhook Event     | Hub Action Route                | Hub Canonical Event                                     |
| ------- | ------------------------- | ------------------------------- | ------------------------------------------------------- |
| Cancel  | `shopify/order.cancelled` | `POST /api/actions/cancel`      | Emits `shopify/order.cancelled`                         |
| Refund  | `shopify/refund.created`  | `POST /api/actions/refund`      | Relies on Shopify webhook                               |
| Fulfill | `shopify/order.fulfilled` | `POST /api/actions/fulfillment` | Emits `shopify/order.fulfilled` (fromManualFulfillment) |

## Inngest Functions

| Function                      | Event                     | Purpose                                        |
| ----------------------------- | ------------------------- | ---------------------------------------------- |
| `process-order-cancellation`  | `shopify/order.cancelled` | GPS cancel + Shopify uncancel safeguard        |
| `process-shopify-refund`      | `shopify/refund.created`  | D365 refund line + return fulfilment + invoice |
| `process-shopify-fulfillment` | `shopify/order.fulfilled` | D365 packing slip + prepayment                 |
| `process-action-cancel`       | `action/order.cancel`     | UI tracking + CS platform notification         |
| `process-action-refund`       | `action/order.refund`     | UI tracking only                               |
| `process-action-fulfill`      | `action/order.fulfill`    | UI tracking only                               |

## Pending Actions / Deferral

All three flows support deferral when downstream systems are not ready:

| Flow    | Defers When                | Replay Via                   |
| ------- | -------------------------- | ---------------------------- |
| Cancel  | GPS order not yet created  | `drain-pending-actions` cron |
| Refund  | D365 order not yet created | `drain-pending-actions` cron |
| Fulfill | D365 order not yet created | `drain-pending-actions` cron |

## GPS API Capabilities

The GPS OMS API supports:

- `POST /openapi/v1/outboundOrder/create` — Create outbound order
- `POST /openapi/v1/outboundOrder/detail` — Get order details / status
- `POST /openapi/v1/outboundOrder/cancel` — Cancel outbound order (async with polling)

There is no "fulfill" or "mark shipped" endpoint. GPS fulfillment is warehouse-driven: when the warehouse ships, the order status changes, and `cron-gps-sync` detects it.

## Related Docs

- [Flow 1: Order Creation & Payment](./01-order-creation-payment.md)
- [Flow 3: GPS Fulfillment (Pull-Based)](./03-gps-fulfillment.md)
- [Flow 5: Refunds](./05-refunds.md)
- [Flow 7: Fulfillment D365 Sync](./07-shopify-direct-fulfillment.md)
- [Flow 8: Cancellation Orchestration](./08-cancel-gps-and-uncancel.md)
