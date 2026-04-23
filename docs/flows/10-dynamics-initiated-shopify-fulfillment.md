# Flow 10: Dynamics-Initiated Shopify Fulfillment (Battle Bus)

> **Direction:** Dynamics 365 → Battle Bus → Inngest → Shopify  
> **Parity:** Replaces the spock-store path `POST /v1.0/dynamics/fulfilment/notification` when WMS is driven from D365 and Shopify must be updated to match an existing D365 shipment.

## Overview

When D365 (or a relay) is the **source of truth** for a shipment, it notifies Battle Bus. Battle Bus enqueues an Inngest run that resolves the corresponding Shopify order, creates a **Shopify** fulfillment (REST `fulfillments.json`), and tags that fulfillment so we **do not** run the usual D365 packing-slip sync again when Shopify fires `orders/fulfilled`.

```
┌───────────────┐   POST …/dynamics/fulfillment   ┌──────────────┐   dynamics/         ┌──────────────┐   POST            ┌───────────┐
│  Dynamics 365 │ ────────────────────────────►  │  Battle Bus  │   fulfillment.    │   Inngest     │  fulfillments   │  Shopify  │
│  (WMS / relay) │  (HMAC, Bearer, or ?apiKey=)  │  (webhook)   │   notify  ───►    │  function     │  .json  ───►   │  Admin    │
└───────────────┘                                 └──────────────┘                   └──────────────┘                 └───────────┘
```

For historical simulator-oriented notes, see [04-dynamics-fulfillment-notification.md](./04-dynamics-fulfillment-notification.md). This document describes the **implemented** Battle Bus path.

## HTTP endpoint

| Item | Value |
| ---- | ----- |
| Method | `POST` |
| Path | `/api/webhooks/dynamics/fulfillment` |
| Base URL | Your deployed Battle Bus (Inngest) host, e.g. `https://<deployment>/api/webhooks/dynamics/fulfillment` |
| Response | `202` with `{"received": true}` when the event is accepted; `202` empty body when `customerAccount` is filtered out (see below) |

**GET** the same path returns a small health JSON for probes.

## Authentication

At least one of the following must be configured and used:

| Method | How |
| ------ | --- |
| Bearer token | `Authorization: Bearer <DYNAMICS_FULFILLMENT_WEBHOOK_SECRET>` |
| Query string (spock-style) | `?apiKey=<DYNAMICS_FULFILLMENT_WEBHOOK_SECRET>` |
| HMAC (Battle Hub style) | Body signed with `BATTLE_BUS_WEBHOOK_SECRET`, hex digest in `x-battle-bus-signature` (same contract as other internal Battle Bus webhooks) |

If neither secret is set, the route responds `500` with a configuration error.

## Customer account filter (optional)

Aligned with spock’s “Shopify-originating customer” idea:

- `D365_FULFILLMENT_SHOPIFY_CUSTOMER_ACCOUNTS` — comma-separated list (default: `IM8-SHOPIFY`).
- If the env value is **empty**, all customer accounts are allowed.
- If the payload omits `customerAccount`, the request is **accepted** (allowed).
- If `customerAccount` is present and not in the list, the handler returns **202** and **does not** enqueue an Inngest event (same as “skip non-Shopify account” in spock).

## Request body (D365 contract)

The payload matches the `DynamicsFulfilmentRequest` shape used in spock and `src/lib/types/dynamics-fulfilment.ts`.

**Required (top level)**

| Field | Type | Description |
| ----- | ---- | ----------- |
| `type` | `"shipment"` \| `"return"` | Only `shipment` creates Shopify fulfillments; `return` is accepted but not implemented for Shopify side effects. |
| `salesOrderNumber` | string | D365 sales order number, e.g. `U001-SO-123456`. |
| `dataAreaId` | string | D365 data area, e.g. `U001`. |
| `lines` | array | Shipment line details (see below). |

**Optional**

| Field | Description |
| ----- | ------------ |
| `customerAccount` | Filtered when `D365_FULFILLMENT_SHOPIFY_CUSTOMER_ACCOUNTS` is set. |
| `completed` | Passed through; informational. |
| `confirmedShippedDate` | Passed through. |

**Each line (shipment)**

| Field | Description |
| ----- | ------------ |
| `quantity` | Shipped quantity (must be non-negative for processing). |
| `itemNumber` | D365 item / SKU. |
| `trackingNumber` | Tracking number (used for Shopify tracking + link). |
| `shippingSiteId` | Preserved in types; not required for the current mapper. |
| `ModeOfDelivery` | Optional; mapped toward a carrier display name for `tracking_info.company`. |

**Example (shipment)**

```json
{
  "customerAccount": "IM8-SHOPIFY",
  "type": "shipment",
  "salesOrderNumber": "U001-SO-123456",
  "dataAreaId": "U001",
  "completed": true,
  "lines": [
    {
      "quantity": 1,
      "itemNumber": "IM8-FG-000010",
      "trackingNumber": "DHL1234567890",
      "shippingSiteId": "GPS-US",
      "ModeOfDelivery": "DHL-EXPRESS"
    }
  ]
}
```

**Event idempotency:** The route sends Inngest an event with a stable `id` derived from `salesOrderNumber` and a short hash of `lines` so replays of the same shipment are deduplicated at the Inngest event layer when appropriate.

## Inngest

| Item | Value |
| ---- | ----- |
| Event name | `dynamics/fulfillment.notify` |
| Function | `process-dynamics-initiated-fulfillment` (`inngest/src/inngest/functions/process-dynamics-initiated-fulfillment.ts`) |

**Processing steps (summary)**

1. Skip or no-op in `DRY_RUN_MODE`.
2. `type === "return"` → log and return `return_not_implemented`.
3. Load D365 header with `getSalesOrderByNumber(salesOrderNumber, dataAreaId)`.
4. Read `THK_ShopifyReference` to locate the Shopify order (numeric id or order name, then `getOrder` / `searchOrdersByName`).
5. Load `GET .../fulfillment_orders.json`, pick the first `open` or `in_progress` fulfillment order.
6. Map D365 `itemNumber` to Shopify using the same merge/refill path as the rest of Battle Bus: `mapShopifySkuToDynamics` on the Shopify line SKU must match the D365 `itemNumber` (normalized) for a fulfillment order line; quantities respect partial shipment vs `fulfillable_quantity`.
7. If `ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK` is not `true`, **no** `POST /fulfillments.json` (same safety switch as GPS writeback). Otherwise call `createFulfillment` with `fulfillmentType: "dynamics_initiated"`.
8. Flow logging uses `dynamics_shopify_fulfill` in Supabase flow logs for observability.

## Why the Shopify `orders/fulfilled` path does not double-post D365

Creating a fulfillment in Shopify triggers the `orders/fulfilled` webhook and thus `process-shopify-fulfillment` (packing slip + prepayment in D365). For this flow, D365 is **already** the ship source, so the packing slip is not required again.

Battle Bus encodes a fulfillment **note** on create: `FulfillmentType: dynamics_initiated` (see `lib/clients/shopify` `createFulfillment`). The handler for `shopify/order.fulfilled` inspects the fulfillment `note` and, when that marker is present, **skips** the D365 packing slip / prepayment work for that run.

**Related (inverse direction):** [07-shopify-direct-fulfillment.md](./07-shopify-direct-fulfillment.md) — Shopify / Hub is the source of truth and D365 is updated from webhooks or cron.

## Environment checklist

| Variable | Purpose |
| -------- | -------- |
| `DYNAMICS_FULFILLMENT_WEBHOOK_SECRET` | Bearer or `?apiKey=` for inbound Dynamics / relay. |
| `BATTLE_BUS_WEBHOOK_SECRET` | Optional; enables HMAC header auth. |
| `D365_FULFILLMENT_SHOPIFY_CUSTOMER_ACCOUNTS` | Optional override for allowed `customerAccount` values. |
| D365 + Shopify credentials | As for all Battle Bus flows (read header, read FO, create fulfillment). |
| `ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK` | Must be `true` to actually call Shopify; otherwise the run logs a writeback-off outcome. |
| `DRY_RUN_MODE` | If `true`, no external writes. |

## See also

- [D365_FLOWS_AND_STEPS.md](../D365_FLOWS_AND_STEPS.md) — broader D365 operation index.
- [07-shopify-direct-fulfillment.md](./07-shopify-direct-fulfillment.md) — fulfillments originating in Shopify and syncing **to** D365.
