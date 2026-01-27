# Flow 4: Dynamics Fulfilment Notifications

> **Journey Name:** Dynamics pushes fulfilment/return events to spock-store  
> **Direction:** Dynamics 365 → spock-store → Shopify

## Overview

This flow tests when Dynamics 365 is the **source of truth** for fulfillment and pushes notifications to spock-store, which then creates fulfillments in Shopify. This path is used when the WMS is fully coupled to Dynamics rather than directly integrated with spock-store.

```
┌───────────────┐   POST fulfilment/notification   ┌─────────────┐   POST fulfillments.json   ┌─────────────┐
│  Dynamics 365 │ ──────────────────────────────►  │ spock-store │ ─────────────────────────► │   Shopify   │
└───────────────┘                                  └─────────────┘                            └─────────────┘
```

## Trigger Events

- Dynamics 365 ships an order (via WMS integration)
- Dynamics creates a shipment record
- Dynamics pushes notification to spock-store with:
  - `type: 'shipment'` - Order shipped
  - `type: 'return'` - Return processed

## Key Endpoints

| System | Direction | Endpoint | Description |
|--------|-----------|----------|-------------|
| Dynamics → spock-store | Inbound | `POST /v1.0/dynamics/fulfilment/notification` | Receives fulfillment notification |
| spock-store → Shopify | Outbound | `POST /admin/api/.../fulfillments.json` | Creates Shopify fulfillment |
| spock-store → Shopify | Outbound | `GET /admin/api/.../fulfillment_orders.json` | Gets fulfillment orders |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `dynamicsSalesOrderNumber`
   - Status: `processing`

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

3. **Configure spock-store** to accept Dynamics notifications

---

## Test Scenarios

### Scenario 4.1: Standard Shipment Notification

**Description:** Dynamics notifies spock-store of a completed shipment.

#### Step 1: Setup - Create Order with Dynamics SO

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
      "province": "California",
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

# Send orders/paid webhook (creates Dynamics SO)
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

**Note the `dynamicsSalesOrderNumber` from the response.**

#### Step 2: Send Dynamics Fulfillment Notification

```bash
curl -X POST http://localhost:3100/webhooks/dynamics/fulfillment \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "type": "shipment"
  }'
```

**Expected Response:**
```json
{
  "order": {
    "id": "<uuid>",
    "dynamicsSalesOrderNumber": "U001-SO-123456"
  },
  "payload": {
    "customerAccount": "IM8-SHOPIFY",
    "type": "shipment",
    "salesOrderNumber": "U001-SO-123456",
    "dataAreaId": "U001",
    "completed": true,
    "confirmedShippedDate": "1/15/2024",
    "lines": [{
      "quantity": 1,
      "itemNumber": "IM8-FG-000010",
      "trackingNumber": "TRACK1234567890",
      "shippingSiteId": "GPS-US",
      "ModeOfDelivery": "STANDARD"
    }]
  },
  "response": {
    "status": 200,
    "data": { ... }
  }
}
```

#### Step 3: Actual Dynamics Notification Payload

When Dynamics sends a notification to spock-store, it uses this format:

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{
    "customerAccount": "IM8-SHOPIFY",
    "type": "shipment",
    "salesOrderNumber": "U001-SO-123456",
    "dataAreaId": "U001",
    "completed": true,
    "confirmedShippedDate": "01/15/2024",
    "lines": [{
      "quantity": 1,
      "itemNumber": "IM8-FG-000010",
      "trackingNumber": "DHL1234567890",
      "shippingSiteId": "GPS-US",
      "ModeOfDelivery": "STANDARD"
    }]
  }' \
  --url-query "apiKey=your-api-key"
```

#### Step 4: Expected spock-store Processing

**What spock-store should do:**

1. **Validate request:**
   - Check `customerAccount` is Shopify-origin
   - Validate `dataAreaId`

2. **Create Task:**
   ```javascript
   Task.create({
     type: 'dynamics',
     detail: {
       topic: 'fulfilment',
       body: payload
     }
   })
   ```

3. **Process Task (`processDynamicsEvent`):**
   - For `type === 'shipment'`:
     - Call `notifyShopifyFulfilmentFromDynamics(detail.body)`

4. **Create Shopify Fulfillment:**
   - Find SalesOrder by `salesOrderNumber`
   - Build `ShopifyFulfilmentRequest`
   - Call Shopify fulfillments API

---

### Scenario 4.2: Return Notification

**Description:** Dynamics notifies spock-store of a processed return.

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{
    "customerAccount": "IM8-SHOPIFY",
    "type": "return",
    "salesOrderNumber": "U001-SO-123456",
    "dataAreaId": "U001",
    "completed": true,
    "confirmedShippedDate": "01/20/2024",
    "lines": [{
      "quantity": -1,
      "itemNumber": "IM8-FG-000010",
      "returnReason": "customer_request"
    }]
  }' \
  --url-query "apiKey=your-api-key"
```

**Expected Behavior:**
- spock-store identifies return by negative quantity or `type: 'return'`
- May create refund/negative fulfillment logic
- Business rules determine Shopify action (refund vs. return label)

---

### Scenario 4.3: Partial Shipment

**Description:** Dynamics ships only some items from a multi-item order.

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{
    "customerAccount": "IM8-SHOPIFY",
    "type": "shipment",
    "salesOrderNumber": "U001-SO-123456",
    "dataAreaId": "U001",
    "completed": false,
    "confirmedShippedDate": "01/15/2024",
    "lines": [{
      "quantity": 1,
      "itemNumber": "IM8-FG-000010",
      "trackingNumber": "DHL1234567890",
      "shippingSiteId": "GPS-US",
      "ModeOfDelivery": "STANDARD"
    }]
  }' \
  --url-query "apiKey=your-api-key"
```

**Expected Behavior:**
- `completed: false` indicates partial shipment
- Shopify fulfillment created for shipped items only
- Order `fulfillment_status` = `partial`

---

### Scenario 4.4: UK Order Notification

**Description:** Dynamics fulfillment for UK warehouse.

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{
    "customerAccount": "IM8-SHOPIFY",
    "type": "shipment",
    "salesOrderNumber": "H007-SO-654321",
    "dataAreaId": "H007",
    "completed": true,
    "confirmedShippedDate": "01/15/2024",
    "lines": [{
      "quantity": 1,
      "itemNumber": "IM8-FG-000020",
      "trackingNumber": "RM123456789GB",
      "shippingSiteId": "GPS-UK",
      "ModeOfDelivery": "STANDARD"
    }]
  }' \
  --url-query "apiKey=your-api-key"
```

---

## Request Schema

### DynamicsFulfilmentRequest

```typescript
interface DynamicsFulfilmentRequest {
  customerAccount: string;           // e.g., "IM8-SHOPIFY"
  type: 'shipment' | 'return';
  salesOrderNumber: string;          // Dynamics SO number
  dataAreaId: 'U001' | 'H007';       // US or UK
  completed: boolean;                 // Full or partial shipment
  confirmedShippedDate: string;      // MM/DD/YYYY format
  lines: DynamicsFulfilmentLine[];
}

interface DynamicsFulfilmentLine {
  quantity: number;                   // Negative for returns
  itemNumber: string;                 // SKU
  trackingNumber?: string;
  shippingSiteId: string;            // e.g., "GPS-US", "GPS-UK"
  ModeOfDelivery: string;            // e.g., "STANDARD"
  returnReason?: string;             // For returns
}
```

---

## Validation Checklist

| Step | Check | Method |
|------|-------|--------|
| 1 | Request authenticated (API key) | Check request headers |
| 2 | customerAccount validated | Verify Shopify-origin |
| 3 | dataAreaId is valid | Check U001 or H007 |
| 4 | SalesOrder found | Query by SO number |
| 5 | Task created | Check spock-store DB |
| 6 | Shopify fulfillment created | Check Shopify API call |
| 7 | Fulfillment entity updated | Check spock-store DB |

---

## Response Codes

| Status | Meaning |
|--------|---------|
| 200 | Success - notification processed |
| 400 | Bad request - invalid payload |
| 401 | Unauthorized - invalid API key |
| 404 | Not found - sales order not found |
| 500 | Server error |

---

## Error Scenarios

### Error 4.1: Invalid Customer Account

**Trigger:** `customerAccount` not associated with Shopify

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{
    "customerAccount": "INVALID-ACCOUNT",
    "type": "shipment",
    "salesOrderNumber": "U001-SO-123456",
    ...
  }'
```

**Expected:** 400 Bad Request or ignored

### Error 4.2: Sales Order Not Found

**Trigger:** `salesOrderNumber` doesn't match any order

**Expected Behavior:**
- Log warning
- Return acknowledgment (prevent retries)
- May need manual investigation

### Error 4.3: Invalid DataAreaId

**Trigger:** `dataAreaId` not U001 or H007

**Expected:** 400 Bad Request

### Error 4.4: Missing API Key

**Trigger:** No `apiKey` query parameter

```bash
curl -X POST http://localhost:8080/v1.0/dynamics/fulfilment/notification \
  -H "Content-Type: application/json" \
  -d '{ ... }'
# Missing ?apiKey=...
```

**Expected:** 401 Unauthorized

---

## Data Mapping

### Dynamics → Shopify Fulfillment

| Dynamics Field | Shopify Fulfillment Field |
|----------------|---------------------------|
| `lines[].trackingNumber` | `tracking_info.number` |
| `lines[].ModeOfDelivery` | `tracking_info.company` (mapped) |
| `lines[].quantity` | `line_items[].quantity` |
| `lines[].itemNumber` | `line_items[].sku` |
| `confirmedShippedDate` | `created_at` |

### Carrier Mapping

| Dynamics ModeOfDelivery | Shopify Carrier |
|-------------------------|-----------------|
| STANDARD | "Standard Shipping" |
| EXPRESS | "Express Shipping" |
| DHL | "DHL" |
| FEDEX | "FedEx" |
| ROYALMAIL | "Royal Mail" |

---

## Integration Notes

- Dynamics is **authoritative** in this flow
- spock-store trusts Dynamics `lines` and `confirmedShippedDate`
- Good for scenarios where WMS is Dynamics-integrated
- Unlike GPS flow, this is **push-based** (Dynamics initiates)
- Returns may require additional Shopify refund logic

---

## Testing with Simulator

```bash
# Quick test using simulator's webhook endpoint
curl -X POST http://localhost:3100/webhooks/dynamics/fulfillment \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "type": "shipment"
  }'
```

This will:
1. Find the order in simulator state
2. Build a proper Dynamics notification payload
3. Send to spock-store's `/v1.0/dynamics/fulfilment/notification` endpoint
4. Return the response

---

## Notes

- `customerAccount` validation prevents processing non-Shopify orders
- The API key provides basic authentication
- Dynamics may send multiple notifications for same order (idempotency needed)
- Returns with negative quantities trigger different logic than shipments
- `completed: true` vs `false` affects Shopify `fulfillment_status`

