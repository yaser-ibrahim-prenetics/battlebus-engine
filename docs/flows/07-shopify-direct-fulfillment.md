# Flow 7: Shopify Direct Fulfilments

> **Journey Name:** Shopify marks order fulfilled directly (e.g., manual or via another WMS like Stord)  
> **Direction:** Shopify → battle-bus → Dynamics

## Overview

This flow tests when Shopify is the **source of truth** for fulfillment, not GPS or Extensiv. This happens when:

- Orders are fulfilled manually in Shopify admin
- A different WMS (like Stord) fulfills directly through Shopify
- Third-party logistics provider integrates with Shopify directly

In this case, battle-bus receives the `orders/fulfilled` webhook and needs to:

1. Update internal `SalesOrder` and `Fulfilment` entities
2. Notify Dynamics 365 of the fulfillment

```
┌─────────────┐   orders/fulfilled   ┌─────────────┐   POST fulfilment   ┌───────────────┐
│   Shopify   │ ───────────────────► │ battle-bus │ ─────────────────► │  Dynamics 365 │
│  (Manual    │      webhook         └─────────────┘                    └───────────────┘
│   or WMS)   │                             │
└─────────────┘                             │  Update Fulfilment entity
                                            ▼
                                     ┌─────────────┐
                                     │ Internal DB │
                                     └─────────────┘
```

## Trigger Events

- Manual fulfillment in Shopify admin
- Stord or other WMS fulfills and notifies Shopify
- Shopify fires `orders/fulfilled` webhook

## Key Endpoints

| System                | Direction | Endpoint                            | Description                  |
| --------------------- | --------- | ----------------------------------- | ---------------------------- |
| Shopify → battle-bus  | Inbound   | `POST /v1.0/shopify/webhook`        | Receives fulfilled webhook   |
| battle-bus → Dynamics | Outbound  | `POST /api/services/.../fulfilment` | Creates Dynamics fulfillment |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `shopifyOrderId`
   - `dynamicsSalesOrderNumber` populated
   - Status: `paid` or `processing`

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

---

## Test Scenarios

### Scenario 7.1: Manual Fulfillment in Shopify

**Description:** Admin manually fulfills order in Shopify admin panel.

#### Step 1: Create and Pay Order

```bash
# Create order
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "id": "100001",
      "email": "john.doe@example.com",
      "firstName": "John",
      "lastName": "Doe"
    },
    "shippingAddress": {
      "address1": "123 Main Street",
      "city": "Los Angeles",
      "province": "CA",
      "country": "United States",
      "zip": "90001",
      "countryCode": "US"
    },
    "lineItems": [{
      "id": "1001",
      "sku": "IM8-FG-000010",
      "name": "IM8 Premium DNA Test",
      "quantity": 1,
      "price": "199.00"
    }],
    "dataAreaId": "U001"
  }'

# Send orders/paid webhook
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

#### Step 2: Send `orders/fulfilled` Webhook

```bash
curl -X POST http://localhost:3100/webhooks/shopify/orders/fulfilled \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "trackingNumber": "DHL1234567890",
    "carrier": "DHL"
  }'
```

**Expected Response:**

```json
{
  "order": {
    "id": "<uuid>",
    "shopifyOrderName": "IM8-1001",
    "trackingNumber": "DHL1234567890"
  },
  "webhook": {
    "success": true,
    "status": 200
  }
}
```

#### Step 3: Verify State

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected:**

```json
{
  "id": "<uuid>",
  "shopifyOrderName": "IM8-1001",
  "status": "fulfilled",
  "trackingNumber": "DHL1234567890",
  "carrier": "DHL",
  "fulfillmentId": "<fulfillment_id>"
}
```

---

### Scenario 7.2: Stord WMS Fulfillment

**Description:** Stord fulfills order and notifies Shopify, which sends webhook to battle-bus.

The Shopify webhook payload when fulfilled via Stord:

```json
{
  "id": 12345678901234,
  "name": "IM8-1001",
  "fulfillment_status": "fulfilled",
  "fulfillments": [
    {
      "id": 5555555555555,
      "order_id": 12345678901234,
      "status": "success",
      "created_at": "2024-01-15T10:30:00.000Z",
      "tracking_company": "DHL",
      "tracking_number": "DHL1234567890",
      "tracking_numbers": ["DHL1234567890"],
      "tracking_url": "https://track.dhl.com/DHL1234567890",
      "tracking_urls": ["https://track.dhl.com/DHL1234567890"],
      "location_id": 71234567890,
      "origin_address": {
        "name": "Stord Warehouse",
        "address1": "100 Warehouse Way",
        "city": "Atlanta",
        "province": "Georgia",
        "country": "United States",
        "zip": "30301"
      },
      "line_items": [
        {
          "id": 1001,
          "sku": "IM8-FG-000010",
          "name": "IM8 Premium DNA Test",
          "quantity": 1,
          "fulfillment_status": "fulfilled"
        }
      ]
    }
  ],
  "line_items": [
    {
      "id": 1001,
      "sku": "IM8-FG-000010",
      "name": "IM8 Premium DNA Test",
      "quantity": 1,
      "fulfillment_status": "fulfilled"
    }
  ]
}
```

---

### Scenario 7.3: Partial Fulfillment from Shopify

**Description:** Only some items fulfilled via Shopify/Stord.

```bash
# Create multi-item order
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "100001", "email": "test@example.com", "firstName": "John", "lastName": "Doe"},
    "shippingAddress": {"address1": "123 Main St", "city": "LA", "province": "CA", "country": "US", "zip": "90001", "countryCode": "US"},
    "lineItems": [
      {"id": "1001", "sku": "IM8-FG-000010", "name": "Item 1", "quantity": 2, "price": "99.00"},
      {"id": "1002", "sku": "IM8-FG-000020", "name": "Item 2", "quantity": 1, "price": "49.00"}
    ],
    "dataAreaId": "U001"
  }'
```

Partial fulfillment webhook:

```json
{
  "id": 12345678901234,
  "name": "IM8-1002",
  "fulfillment_status": "partial",
  "fulfillments": [
    {
      "id": 5555555555555,
      "status": "success",
      "line_items": [
        {
          "id": 1001,
          "sku": "IM8-FG-000010",
          "quantity": 1
        }
      ]
    }
  ],
  "line_items": [
    { "id": 1001, "sku": "IM8-FG-000010", "quantity": 2, "fulfillment_status": "partial" },
    { "id": 1002, "sku": "IM8-FG-000020", "quantity": 1, "fulfillment_status": null }
  ]
}
```

**Expected Behavior:**

- Fulfillment created for shipped items
- Order `fulfillment_status` = `partial`
- Remaining items tracked for future fulfillment

---

### Scenario 7.4: Full Flow with CLI

```bash
# Create and fulfill order
npm run flow:order -- --template usGpsOrder --fulfill
```

Note: The CLI uses the fulfilled webhook after marking GPS fulfillment, which is the same `orders/fulfilled` topic.

---

## battle-bus Processing Logic

### notifyDynamicsOnStordFulfilment Flow

```javascript
async function notifyDynamicsOnStordFulfilment(detail: ShopifyOrderFulfilledDetail) {
  // 1. Find SalesOrder by Shopify ID
  const salesOrder = await findByShopifyOrderId(detail.id);

  if (!salesOrder) {
    logger.warn('SalesOrder not found for fulfilled webhook', { orderId: detail.id });
    return;
  }

  // 2. Check if order is cancelled
  if (detail.cancelled_at) {
    await handleCancelledOrder(salesOrder, detail);
    return;
  }

  // 3. Extract fulfillments from webhook
  const fulfillments = detail.fulfillments || [];

  for (const fulfillment of fulfillments) {
    // 4. Skip dummy/refund fulfillments
    if (isDummyFulfillment(fulfillment)) {
      continue;
    }

    // 5. Create/update Fulfilment entity
    const fulfilmentEntity = await createOrUpdateFulfilment({
      salesOrderId: salesOrder.id,
      shopifyFulfilmentId: fulfillment.id.toString(),
      trackingNumber: fulfillment.tracking_number,
      carrier: fulfillment.tracking_company,
      lineItems: fulfillment.line_items,
    });

    // 6. Send to Dynamics
    await fuflfilOrderToDynamics(salesOrder, fulfillment);
  }
}
```

### fuflfilOrderToDynamics

```javascript
async function fuflfilOrderToDynamics(salesOrder: SalesOrder, fulfillment: ShopifyFulfillment) {
  const request = {
    FulfilmentRequest: {
      D365FOSalesOrder: salesOrder.dynamicsSalesOrderNumber,
      ConfirmedShippedDate: formatDate(fulfillment.created_at),
      Type: 'shipment',
      Lines: fulfillment.line_items.map(item => ({
        ItemNumber: item.sku,
        quantity: item.quantity,
        TrackingNumber: fulfillment.tracking_number,
        shippingSiteId: getShippingSiteId(salesOrder.dataAreaId),
        ModeOfDelivery: 'STANDARD',
      })),
    },
  };

  await dynamicsClient.post('/api/services/.../fulfilment', request);
}
```

---

## Shopify Webhook Payload

### `orders/fulfilled` Full Schema

```typescript
interface ShopifyOrderFulfilledWebhook {
  id: number;
  admin_graphql_api_id: string;
  name: string; // e.g., "IM8-1001"
  email: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  closed_at: string | null;
  financial_status: string;
  fulfillment_status: "fulfilled" | "partial" | null;

  customer: {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
  };

  fulfillments: ShopifyFulfillment[];
  line_items: ShopifyLineItem[];
}

interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: "pending" | "open" | "success" | "cancelled" | "error" | "failure";
  created_at: string;
  updated_at: string;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_numbers: string[];
  tracking_url: string | null;
  tracking_urls: string[];
  location_id: number;
  origin_address: Address | null;
  line_items: FulfillmentLineItem[];
  name: string; // e.g., "#IM8-1001.1"
  shipment_status: string | null;
}

interface FulfillmentLineItem {
  id: number;
  variant_id: number;
  title: string;
  quantity: number;
  sku: string;
  name: string;
  price: string;
  fulfillment_status: string;
}
```

---

## Validation Checklist

| Step | Check                           | Method                  |
| ---- | ------------------------------- | ----------------------- |
| 1    | Fulfilled webhook received      | Check battle-bus logs   |
| 2    | SalesOrder found                | Query by Shopify ID     |
| 3    | Fulfilment entity created       | Check internal DB       |
| 4    | `shopifyFulfilmentId` populated | Verify not dummy ID     |
| 5    | Tracking info stored            | Check DB fields         |
| 6    | Dynamics fulfillment sent       | Check Dynamics API logs |
| 7    | Order status = fulfilled        | `GET /state/orders/:id` |

---

## Error Scenarios

### Error 7.1: SalesOrder Not Found

**Trigger:** Fulfilled webhook for order not in battle-bus

**Expected Behavior:**

- Log warning
- Return acknowledgment
- May need to re-sync from Shopify

### Error 7.2: Dynamics API Failure

**Trigger:** Dynamics returns error

**Expected Behavior:**

- Fulfillment still recorded locally
- Log Dynamics error
- May retry notification

### Error 7.3: Duplicate Fulfillment Webhook

**Trigger:** Same webhook received twice

**Expected Behavior:**

- Idempotent processing
- Skip if `shopifyFulfilmentId` already exists
- Log duplicate detection

---

## Special Cases

### Cancelled Order with Fulfillment

Order may be cancelled after partial fulfillment:

```json
{
  "id": 12345678901234,
  "cancelled_at": "2024-01-15T12:00:00.000Z",
  "fulfillment_status": "partial",
  "fulfillments": [
    {
      "id": 5555555555555,
      "status": "success",
      "line_items": [{ "sku": "IM8-FG-000010", "quantity": 1 }]
    }
  ]
}
```

**Handling:**

- Process fulfillments normally
- Then apply cancellation logic
- Do NOT create dummy fulfillment (real one exists)

### Dummy SKU Filtering

Filter out dummy/adjustment SKUs:

```javascript
const isRealLineItem = (item) => {
  return (
    item.sku &&
    !item.sku.startsWith("ADJUSTMENT") &&
    !item.sku.startsWith("SHIPPING") &&
    !item.price.startsWith("-")
  );
};
```

### Multiple Fulfillments

Order may have multiple fulfillment events:

```json
{
  "fulfillments": [
    { "id": 111, "tracking_number": "DHL111", "line_items": [...] },
    { "id": 222, "tracking_number": "DHL222", "line_items": [...] }
  ]
}
```

**Handling:**

- Create separate Fulfilment entities for each
- Send separate Dynamics notifications
- Or combine into single notification (depends on config)

---

## Interaction with GPS Flow

When using Shopify Direct Fulfillment instead of GPS:

| Aspect                | GPS Flow (Flow 3)       | Shopify Direct (Flow 7)     |
| --------------------- | ----------------------- | --------------------------- |
| Source of truth       | GPS status              | Shopify fulfillment         |
| Direction             | Pull (battle-bus → GPS) | Push (Shopify → battle-bus) |
| Trigger               | Scheduled polling       | Webhook                     |
| Dynamics notification | After GPS status 3      | After webhook               |

**Coexistence:**

- Same order should not use both flows
- GPS orders have `gpsOrderId` populated
- Non-GPS orders don't have `gpsOrderId`

---

## Simulator Test Commands

```bash
# Quick test with fulfillment
npm run flow:order -- --template usGpsOrder --fulfill

# Manual webhook
curl -X POST http://localhost:3100/webhooks/shopify/orders/fulfilled \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "trackingNumber": "TRACK123",
    "carrier": "FedEx"
  }'
```

---

## Notes

- Shopify is **source of truth** for fulfillment in this flow
- battle-bus mirrors fulfillment data and notifies Dynamics
- Works for any fulfillment source that updates Shopify (manual, Stord, etc.)
- Handle partial fulfillments carefully
- Filter out dummy SKUs and refund-related fulfillments
- Idempotency is important for webhook processing
- Dynamics notification happens after Shopify fulfillment is confirmed
