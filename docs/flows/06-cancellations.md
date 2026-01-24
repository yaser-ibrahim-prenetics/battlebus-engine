# Flow 6: Cancellations

> **Journey Name:** Cancelled Shopify orders marked with dummy fulfilment to stop reprocessing  
> **Direction:** Shopify → spock-store → Internal DB (GPS polling exclusion)

## Overview

This flow tests how cancelled Shopify orders are handled by spock-store. The key behavior is creating a **dummy fulfillment record** to prevent the order from being re-polled by GPS scheduled tasks. This ensures cancelled orders don't get accidentally shipped.

```
┌─────────────┐   orders/cancelled    ┌─────────────┐   Create dummy fulfillment   ┌─────────────┐
│   Shopify   │ ────────────────────► │ spock-store │ ────────────────────────────► │ Internal DB │
└─────────────┘     webhook           └─────────────┘                               └─────────────┘
                                             │
                                             │  shopifyFulfilmentId = '00000000000000'
                                             │  (CANCELLED_ORDER_FULFILMENT_ID)
                                             │
                                             ▼
                                      ┌───────────────┐
                                      │ GPS Polling   │ ← Excludes this order
                                      │ Exclusion     │
                                      └───────────────┘
```

## Trigger Events

- Customer cancels order in Shopify
- Admin cancels order in Shopify
- Shopify fires:
  - `orders/cancelled` webhook (primary)
  - `orders/updated` with `cancelled_at` set

## Key Endpoints

| System | Direction | Endpoint | Description |
|--------|-----------|----------|-------------|
| Shopify → spock-store | Inbound | `POST /v1.0/shopify/webhook` | Receives cancellation webhook |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `shopifyOrderId`
   - May have `gpsOrderId` (if already sent to GPS)
   - Status: `paid` or `processing`

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

---

## Key Concept: Dummy Fulfillment ID

### The `CANCELLED_ORDER_FULFILMENT_ID`

```javascript
const CANCELLED_ORDER_FULFILMENT_ID = '00000000000000';
```

When an order is cancelled:
1. spock-store creates a `Fulfilment` entity
2. Sets `shopifyFulfilmentId = '00000000000000'`
3. This special ID is recognized by GPS polling queries

### GPS Polling Exclusion Query

```sql
SELECT * FROM SalesOrder so
LEFT JOIN Fulfilment f ON f.salesOrderId = so.id
WHERE so.gpsOrderId IS NOT NULL
  AND (f.shopifyFulfilmentId IS NULL 
       OR f.shopifyFulfilmentId != '00000000000000')
```

This ensures cancelled orders are **never** re-processed for GPS fulfillment.

---

## Test Scenarios

### Scenario 6.1: Cancel Order Before GPS Fulfillment

**Description:** Order sent to GPS but cancelled before shipping.

#### Step 1: Create Order and Send to GPS

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

# Send orders/paid webhook (creates GPS order)
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

**Verify order state:**
```bash
curl http://localhost:3100/state/orders/IM8-1001
```

Should have `gpsOrderId` populated.

#### Step 2: Send Cancellation Webhook

```bash
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "reason": "customer"
  }'
```

**Expected Response:**
```json
{
  "order": {
    "id": "<uuid>",
    "shopifyOrderName": "IM8-1001",
    "cancelledAt": "2024-01-15T10:30:00.000Z"
  },
  "webhook": {
    "success": true,
    "status": 200
  }
}
```

#### Step 3: Verify Final State

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected:**
```json
{
  "id": "<uuid>",
  "shopifyOrderName": "IM8-1001",
  "status": "cancelled",
  "cancelledAt": "2024-01-15T10:30:00.000Z",
  "cancelReason": "customer",
  "gpsOrderId": "<gps_order_id>"
}
```

---

### Scenario 6.2: Cancel Order via `orders/updated` Webhook

**Description:** Cancellation detected via order update webhook.

#### Shopify Webhook Payload

```json
{
  "id": 12345678901234,
  "name": "IM8-1001",
  "cancelled_at": "2024-01-15T10:30:00.000Z",
  "cancel_reason": "customer",
  "financial_status": "refunded",
  "fulfillment_status": null,
  ...
}
```

**Key Detection Logic:**
```javascript
if (order.cancelled_at !== null) {
  // Order is cancelled
  await handleCancellation(order);
}
```

---

### Scenario 6.3: Cancel with Different Reasons

**Description:** Test various cancellation reasons.

```bash
# Customer requested
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001", "reason": "customer"}'

# Fraud suspected
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1002", "reason": "fraud"}'

# Inventory issues
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1003", "reason": "inventory"}'

# Other
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1004", "reason": "other"}'
```

**Cancel Reasons:**
- `customer` - Customer changed/cancelled order
- `fraud` - Fraudulent order
- `inventory` - Items not in stock
- `declined` - Payment declined
- `other` - Other reason

---

### Scenario 6.4: CLI Cancellation Flow

```bash
# Create order and cancel
npm run flow:order -- --template usGpsOrder --cancel
```

**CLI Output:**
```
🚀 Starting Order Flow Simulation
   Template: usGpsOrder
   Cancel: true

--- Step 1: Create Order ---
📌 Order Created
{
  "id": "uuid-1234",
  "shopifyOrderName": "IM8-1001",
  "dataAreaId": "U001"
}

--- Step 2: Send Shopify orders/paid Webhook ---
📌 Webhook Sent
{
  "success": true,
  "status": 200
}

--- Step 4: Cancel Order ---
📌 Cancellation Webhook Sent
{
  "success": true,
  "status": 200
}

--- Final Order State ---
{
  "status": "cancelled",
  "cancelledAt": "2024-01-15T10:30:00.000Z"
}

✅ Order Flow Complete!
   Order: IM8-1001
   Final Status: cancelled
```

---

### Scenario 6.5: Verify GPS Polling Exclusion

**Description:** Ensure cancelled orders are not picked up by GPS polling.

#### Step 1: Create Multiple Orders

```bash
# Create order 1 (will be cancelled)
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{"dataAreaId": "U001", "shopifyOrderName": "IM8-1001"}'

# Create order 2 (will remain active)
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{"dataAreaId": "U001", "shopifyOrderName": "IM8-1002"}'

# Pay both orders
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid -d '{"orderId": "IM8-1001"}'
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid -d '{"orderId": "IM8-1002"}'

# Cancel order 1
curl -X POST http://localhost:3100/webhooks/shopify/orders/cancelled \
  -d '{"orderId": "IM8-1001", "reason": "customer"}'
```

#### Step 2: Simulate GPS Polling Query

The spock-store GPS polling query should:
- **Include:** IM8-1002 (not cancelled)
- **Exclude:** IM8-1001 (cancelled with dummy fulfillment ID)

```sql
-- What spock-store queries
SELECT * FROM SalesOrder so
JOIN Fulfilment f ON f.salesOrderId = so.id
WHERE so.gpsOrderId IS NOT NULL
  AND f.shopifyFulfilmentId IS NULL
  -- OR explicitly exclude cancelled:
  -- AND f.shopifyFulfilmentId != '00000000000000'
```

---

## Shopify Webhook Payloads

### `orders/cancelled` Webhook

```json
{
  "id": 12345678901234,
  "admin_graphql_api_id": "gid://shopify/Order/12345678901234",
  "name": "IM8-1001",
  "email": "john.doe@example.com",
  "created_at": "2024-01-15T08:00:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z",
  "cancelled_at": "2024-01-15T10:30:00.000Z",
  "cancel_reason": "customer",
  "closed_at": "2024-01-15T10:30:00.000Z",
  "financial_status": "refunded",
  "fulfillment_status": null,
  "line_items": [...],
  "fulfillments": []
}
```

### `orders/updated` with Cancellation

Same structure as above, but topic is `orders/updated` instead of `orders/cancelled`.

---

## spock-store Processing Logic

### handleCancellation Flow

```javascript
async function handleCancellation(shopifyOrder) {
  // 1. Find SalesOrder
  const salesOrder = await findByShopifyOrderId(shopifyOrder.id);
  
  // 2. Update SalesOrder status
  salesOrder.status = 'cancelled';
  salesOrder.cancelledAt = shopifyOrder.cancelled_at;
  salesOrder.cancelReason = shopifyOrder.cancel_reason;
  
  // 3. Create dummy Fulfillment if none exists
  if (!salesOrder.fulfillment || !salesOrder.fulfillment.shopifyFulfilmentId) {
    const dummyFulfillment = await createFulfillment({
      salesOrderId: salesOrder.id,
      shopifyFulfilmentId: CANCELLED_ORDER_FULFILMENT_ID, // '00000000000000'
      shopifyFulfilmentOrderId: await getShopifyFulfilmentOrderId(shopifyOrder),
    });
  }
  
  // 4. Optionally cancel GPS order
  if (salesOrder.gpsOrderId && config.cancelGpsOnCancellation) {
    await cancelGpsOrder(salesOrder.gpsOrderId);
  }
  
  // 5. Optionally notify Dynamics
  if (config.notifyDynamicsOnCancellation) {
    await notifyDynamicsCancellation(salesOrder);
  }
}
```

---

## Validation Checklist

| Step | Check | Method |
|------|-------|--------|
| 1 | Cancellation webhook received | Check spock-store logs |
| 2 | SalesOrder status = cancelled | Query internal DB |
| 3 | `cancelledAt` populated | Check field |
| 4 | `cancelReason` populated | Check field |
| 5 | Dummy fulfillment created | Check Fulfillment table |
| 6 | `shopifyFulfilmentId` = '00000000000000' | Verify dummy ID |
| 7 | Excluded from GPS polling | Run polling query |
| 8 | Not re-processed on subsequent polls | Verify no duplicates |

---

## Error Scenarios

### Error 6.1: Order Not Found

**Trigger:** Cancellation webhook for unknown order

**Expected Behavior:**
- Log warning
- Return acknowledgment (prevent retries)
- May need manual investigation

### Error 6.2: Already Cancelled

**Trigger:** Second cancellation webhook for same order

**Expected Behavior:**
- Idempotent - no duplicate processing
- Log duplicate detection
- Return success

### Error 6.3: Already Fulfilled

**Trigger:** Cancellation for order that has real fulfillment

**Expected Behavior:**
- Log warning - physical shipment already occurred
- Update status to cancelled
- Do NOT overwrite real fulfillment ID with dummy
- May need manual intervention for return

---

## Interaction with Other Flows

### With GPS Fulfillment (Flow 3)

- Cancelled orders excluded from `findSalesOrdersByUnfulfilledGps*` queries
- GPS may need separate cancellation API call
- Dummy fulfillment ID prevents re-polling

### With Refunds (Flow 5)

- Cancellation often accompanied by refund
- Order can be cancelled AND refunded
- Handle both webhooks gracefully

### With Dynamics (Flow 4)

- Dynamics may need cancellation notification
- Sales Order may need to be voided in ERP

---

## Special Cases

### Partial Cancellation

Shopify doesn't support partial cancellation at order level. For partial cancellations:
- Use refunds for unwanted items
- Cancel remaining fulfillment orders
- Or edit order to remove items

### Cancellation After Partial Fulfillment

```javascript
// Order with 2 items, 1 shipped, then cancelled
{
  "fulfillments": [{
    "id": 123456,
    "status": "success",
    "line_items": [{ "sku": "ITEM-1", "quantity": 1 }]
  }],
  "cancelled_at": "2024-01-15T10:30:00.000Z"
}
```

**Handling:**
- Real fulfillment remains intact
- Do NOT create dummy fulfillment (real one exists)
- Remaining items marked as cancelled

### GPS Order Already Shipped

If GPS already shipped the order:
1. Cancellation comes too late
2. Log warning
3. May need return process instead

---

## State Transition Diagram

```
                    orders/paid
        created ──────────────────► paid
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
             orders/cancelled    gps/create     orders/cancelled
                    │                 │                 │
                    ▼                 ▼                 │
               cancelled ◄───── processing             │
                    ▲                 │                 │
                    │            gps/fulfill           │
                    │                 │                 │
                    │                 ▼                 │
                    └──────────── fulfilled ◄──────────┘
                         (with dummy ID)
```

---

## Notes

- The dummy fulfillment ID `'00000000000000'` is crucial for GPS polling exclusion
- Real Shopify fulfillment order IDs are preserved even for cancelled orders
- Cancellation is different from refund (though often paired)
- Consider race conditions between cancellation and GPS shipping
- Log all cancellations for audit trail
- May need manual process for orders cancelled after physical shipment

