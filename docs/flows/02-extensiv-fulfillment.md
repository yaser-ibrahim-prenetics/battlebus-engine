# Flow 2: Extensiv Warehouse Fulfilment

> **Journey Name:** Extensiv confirms outbound shipment → Shopify fulfillment + Dynamics fulfillment  
> **Direction:** Extensiv → battle-bus → Shopify + Dynamics

## Overview

This flow tests the fulfillment journey when Extensiv (3PL/WMS) ships an order and notifies battle-bus, which then creates fulfillments in both Shopify and Dynamics 365.

```
┌───────────────┐  outbound webhook   ┌─────────────┐   POST fulfillments.json   ┌─────────────┐
│    Extensiv   │ ──────────────────► │ battle-bus │ ──────────────────────────► │   Shopify   │
│    (3PL)      │                     └─────────────┘                             └─────────────┘
└───────────────┘                            │
                                             │  POST fulfilment
                                             ▼
                                      ┌───────────────┐
                                      │  Dynamics 365 │
                                      └───────────────┘
```

## Trigger Events

- Extensiv ships the order
- Extensiv sends webhook/event to battle-bus with shipment confirmation
- Contains tracking number, carrier, and shipped line items

## Key Endpoints

| System | Direction | Endpoint | Description |
|--------|-----------|----------|-------------|
| Extensiv → battle-bus | Inbound | `POST /v1.0/extensiv/webhook` | Receives shipment confirmation |
| battle-bus → Shopify | Outbound | `POST /admin/api/.../fulfillments.json` | Creates Shopify fulfillment |
| battle-bus → Shopify | Outbound | `GET /admin/api/.../fulfillment_orders.json` | Gets fulfillment orders |
| battle-bus → Dynamics | Outbound | `POST /api/services/.../fulfilment` | Creates Dynamics fulfillment |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `dynamicsSalesOrderNumber`
   - Valid Extensiv order ID
   - Status: `processing`

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

3. **Configure battle-bus** to use Extensiv integration path

---

## Test Scenarios

### Scenario 2.1: Standard Extensiv Fulfillment

**Description:** Extensiv ships complete order, notifies battle-bus.

#### Step 1: Setup - Create and Process Order

```bash
# Create order
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "id": "100001",
      "email": "test@example.com",
      "firstName": "John",
      "lastName": "Doe"
    },
    "shippingAddress": {
      "address1": "123 Main St",
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

# Send orders/paid webhook (to create Dynamics SO)
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

#### Step 2: Simulate Extensiv Shipment Webhook

Since the simulator doesn't have full Extensiv integration, simulate the webhook payload that battle-bus would receive:

```bash
# This would be sent by Extensiv to battle-bus
# Simulating the payload structure:
curl -X POST http://localhost:8080/v1.0/extensiv/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "order.shipped",
    "orderId": "EXT-12345",
    "referenceNumber": "IM8-1001",
    "shipments": [{
      "shipmentId": "SHIP-001",
      "carrier": "DHL",
      "trackingNumber": "DHL1234567890",
      "trackingUrl": "https://track.dhl.com/DHL1234567890",
      "shippedAt": "2024-01-15T10:30:00Z",
      "lineItems": [{
        "sku": "IM8-FG-000010",
        "quantity": 1
      }]
    }]
  }'
```

#### Step 3: Expected battle-bus Processing

**What battle-bus should do:**

1. **Parse Extensiv webhook** - Create `Task` of type `extensiv`
2. **Find SalesOrder** - Match by `referenceNumber` (Shopify order name)
3. **Create Shopify Fulfillment:**
   ```
   POST /admin/api/2024-01/fulfillments.json
   {
     "fulfillment": {
       "line_items_by_fulfillment_order": {
         "<fulfillment_order_id>": [{
           "id": "<line_item_id>",
           "quantity": 1
         }]
       },
       "tracking_info": {
         "number": "DHL1234567890",
         "company": "DHL",
         "url": "https://track.dhl.com/DHL1234567890"
       },
       "notify_customer": true
     }
   }
   ```
4. **Create Dynamics Fulfillment:**
   ```
   POST /api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment
   {
     "FulfilmentRequest": {
       "D365FOSalesOrder": "U001-SO-123456",
       "ConfirmedShippedDate": "01/15/2024",
       "Type": "shipment",
       "Lines": [{
         "ItemNumber": "IM8-FG-000010",
         "quantity": 1,
         "TrackingNumber": "DHL1234567890",
         "shippingSiteId": "GPS-US"
       }]
     }
   }
   ```
5. **Update internal Fulfilment entity** with `shopifyFulfilmentId`

#### Step 4: Verify Simulator Received Calls

Check Shopify fulfillment endpoint:

```bash
# The simulator logs all requests
# Check that fulfillment was created
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected Response:**
```json
{
  "id": "<uuid>",
  "shopifyOrderName": "IM8-1001",
  "status": "fulfilled",
  "fulfillmentId": "<fulfillment_id>",
  "trackingNumber": "DHL1234567890",
  "carrier": "DHL"
}
```

---

### Scenario 2.2: Partial Fulfillment

**Description:** Extensiv ships only some items from a multi-item order.

#### Setup

```bash
# Create multi-item order
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "id": "100001",
      "email": "test@example.com",
      "firstName": "John",
      "lastName": "Doe"
    },
    "shippingAddress": {
      "address1": "123 Main St",
      "city": "Los Angeles",
      "province": "CA",
      "country": "United States",
      "zip": "90001",
      "countryCode": "US"
    },
    "lineItems": [
      {"id": "1001", "sku": "IM8-FG-000010", "name": "Item 1", "quantity": 2, "price": "99.00"},
      {"id": "1002", "sku": "IM8-FG-000020", "name": "Item 2", "quantity": 1, "price": "49.00"}
    ],
    "dataAreaId": "U001"
  }'
```

#### Extensiv Webhook (Partial)

```json
{
  "eventType": "order.shipped",
  "orderId": "EXT-12345",
  "referenceNumber": "IM8-1002",
  "shipments": [{
    "shipmentId": "SHIP-001",
    "carrier": "DHL",
    "trackingNumber": "DHL1234567890",
    "lineItems": [{
      "sku": "IM8-FG-000010",
      "quantity": 1
    }]
  }]
}
```

**Expected Behavior:**
- Shopify fulfillment created for shipped items only
- Order `fulfillment_status` = `partial`
- Second fulfillment created when remaining items ship

---

### Scenario 2.3: Multiple Tracking Numbers

**Description:** Order ships in multiple packages with different tracking numbers.

```json
{
  "eventType": "order.shipped",
  "orderId": "EXT-12345",
  "referenceNumber": "IM8-1003",
  "shipments": [
    {
      "shipmentId": "SHIP-001",
      "carrier": "DHL",
      "trackingNumber": "DHL1111111111",
      "lineItems": [{"sku": "IM8-FG-000010", "quantity": 1}]
    },
    {
      "shipmentId": "SHIP-002",
      "carrier": "DHL",
      "trackingNumber": "DHL2222222222",
      "lineItems": [{"sku": "IM8-FG-000020", "quantity": 1}]
    }
  ]
}
```

**Expected Behavior:**
- Separate Shopify fulfillments for each tracking number
- Or single fulfillment with multiple tracking numbers (depends on implementation)

---

## Validation Checklist

| Step | Check | Method |
|------|-------|--------|
| 1 | Extensiv webhook received | Check battle-bus logs |
| 2 | SalesOrder found | Check internal DB |
| 3 | Shopify fulfillment_orders fetched | Check Shopify API logs |
| 4 | Shopify fulfillment created | Check `shopifyFulfilmentId` |
| 5 | Dynamics fulfillment notification sent | Check Dynamics API logs |
| 6 | Internal Fulfilment entity created | Check battle-bus DB |
| 7 | Order status updated | `GET /state/orders/:id` |

---

## API Response Reference

### Shopify Fulfillment Orders Response

```json
{
  "fulfillment_orders": [{
    "id": 12345678,
    "order_id": 98765432,
    "status": "open",
    "assigned_location_id": 61813039173,
    "line_items": [{
      "id": 111,
      "quantity": 1,
      "fulfillable_quantity": 1
    }]
  }]
}
```

### Shopify Create Fulfillment Response

```json
{
  "fulfillment": {
    "id": 99887766,
    "order_id": 98765432,
    "status": "success",
    "tracking_company": "DHL",
    "tracking_number": "DHL1234567890",
    "line_items": [{
      "id": 111,
      "sku": "IM8-FG-000010",
      "quantity": 1
    }]
  }
}
```

### Dynamics Fulfillment Response

```json
{
  "$id": "123456",
  "status": "Success",
  "Message": "Fulfillment processed successfully",
  "Result": "{\"SalesOrderNumber\":\"U001-SO-123456\",\"ProcessedLines\":1}"
}
```

---

## Error Scenarios

### Error 2.1: SalesOrder Not Found

**Trigger:** Extensiv webhook with unknown `referenceNumber`

**Expected Behavior:**
- Log warning
- Return acknowledgment (to prevent retries)
- Alert for manual investigation

### Error 2.2: Shopify API Failure

**Trigger:** Shopify returns 429 (rate limit) or 5xx

**Expected Behavior:**
- Retry with exponential backoff
- Do not send Dynamics fulfillment until Shopify succeeds
- Log errors

### Error 2.3: Dynamics API Failure

**Trigger:** Dynamics returns error

**Expected Behavior:**
- Shopify fulfillment still succeeds
- Log Dynamics error
- May retry Dynamics notification

---

## Notes

- Extensiv is the **source of truth** for physical shipment
- Shopify shows customer-facing fulfillment and tracking
- Dynamics gets the ERP fulfillment record
- The order of operations: Shopify fulfillment first, then Dynamics
- `notifyShopifyFulfilmentFromExtensiv` handles the Shopify side
- `fuflfilOrderToDynamics` handles the Dynamics side

