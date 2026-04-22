# Flow 3: GPS Warehouse Fulfilment (Pull-Based)

> **Journey Name:** GPS scheduled polling for fulfilled orders + notifying Shopify/Dynamics  
> **Direction:** spock-store → GPS → spock-store → Shopify + Dynamics

## Overview

This flow tests the GPS fulfillment journey, which is **pull-based**: spock-store periodically polls GPS for order status updates, and when GPS marks an order as shipped (status 3), spock-store notifies both Shopify and Dynamics.

```
                                    ┌───────────┐
                           poll     │    GPS    │
┌─────────────┐ ◄───────────────────│   (3PL)   │
│ spock-store │                     └───────────┘
│  scheduler  │ ─────────────────────────────────────────┐
└─────────────┘                                          │
       │                                                 │
       │  On status=3                                    │
       ▼                                                 │
┌─────────────┐   POST fulfillments.json   ┌─────────────┐
│ spock-store │ ─────────────────────────► │   Shopify   │
│   worker    │                            └─────────────┘
└─────────────┘
       │
       │  POST fulfilment
       ▼
┌───────────────┐
│  Dynamics 365 │
└───────────────┘
```

## Trigger Events

- **Scheduled GPS Task** within spock-store (cron-like job)
- `processGpsTask` with `detail.type === 'scheduled'`
- Queries for unfulfilled GPS orders and checks their status

## Key Endpoints

| System                 | Direction | Endpoint                                     | Description             |
| ---------------------- | --------- | -------------------------------------------- | ----------------------- |
| spock-store → GPS      | Outbound  | `POST /openapi/v1/outboundOrder/detail`      | Gets order status       |
| spock-store → Shopify  | Outbound  | `POST /admin/api/.../fulfillments.json`      | Creates fulfillment     |
| spock-store → Shopify  | Outbound  | `GET /admin/api/.../fulfillment_orders.json` | Gets fulfillment orders |
| spock-store → Dynamics | Outbound  | `POST /api/services/.../fulfilment`          | Creates fulfillment     |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `gpsOrderId` (US) or `gpsUKOrderId` (UK)
   - `dynamicsSalesOrderNumber` populated
   - Status: `processing`
   - No existing fulfillment with `shopifyFulfilmentId`

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

---

## Test Scenarios

### Scenario 3.1: US GPS Order Fulfillment

**Description:** Standard US order fulfilled via GPS polling.

#### Step 1: Create Order and Send to GPS

```bash
# Create order with US dataAreaId
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

# Send orders/paid webhook (creates Dynamics SO + GPS order)
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

**Verify GPS order was created:**

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

Expected fields:

- `gpsOrderId`: populated
- `gpsStatus`: 1 (processing)
- `dynamicsSalesOrderNumber`: populated

#### Step 2: Simulate GPS Fulfillment (Mark as Shipped)

```bash
# Mark order as shipped in GPS (status 3)
curl -X PATCH http://localhost:3100/state/orders/IM8-1001/gps-fulfill \
  -H "Content-Type: application/json" \
  -d '{
    "trackingNumber": "DHL1234567890",
    "carrier": "DHL"
  }'
```

**Expected Response:**

```json
{
  "id": "<uuid>",
  "shopifyOrderName": "IM8-1001",
  "gpsStatus": 3,
  "status": "shipped",
  "trackingNumber": "DHL1234567890",
  "carrier": "DHL"
}
```

#### Step 3: Verify GPS Returns Fulfilled Status

When spock-store polls GPS, simulate the response:

```bash
# Query GPS detail endpoint (what spock-store does)
curl -X POST http://localhost:3100/gps/openapi/v1/outboundOrder/detail \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "outboundOrderNoList": ["<gpsOrderId>"]
    }
  }'
```

**Expected Response:**

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": [
    {
      "outboundOrderNo": "<gpsOrderId>",
      "status": 3,
      "logisticsTrackNo": "DHL1234567890",
      "logisticsCarrier": "DHL",
      "platformOrderNo": "IM8-1001",
      "outboundTime": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

#### Step 4: spock-store Processing (Simulated)

**What spock-store's scheduled task does:**

1. **Query unfulfilled orders:**

   ```sql
   SELECT * FROM SalesOrder
   WHERE gpsOrderId IS NOT NULL
   AND (Fulfilment.shopifyFulfilmentId IS NULL
        OR Fulfilment.shopifyFulfilmentId != '00000000000000')
   ```

2. **Batch fetch GPS details:**

   ```
   POST /openapi/v1/outboundOrder/detail
   { "data": { "outboundOrderNoList": ["GPS1234ABCD", "GPS5678EFGH"] } }
   ```

3. **For status === 3 orders, create individual tasks:**

   ```javascript
   processIndividualGpsOrder(taskId, orderData, warehouse);
   ```

4. **Notify Shopify:**

   ```
   POST /admin/api/.../fulfillments.json
   ```

5. **Notify Dynamics:**
   ```
   POST /api/services/.../fulfilment
   ```

#### Step 5: Send Fulfilled Webhook (Manual Trigger)

```bash
# Send orders/fulfilled webhook to complete the flow
curl -X POST http://localhost:3100/webhooks/shopify/orders/fulfilled \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001",
    "trackingNumber": "DHL1234567890",
    "carrier": "DHL"
  }'
```

#### Step 6: Verify Final State

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected:**

```json
{
  "status": "fulfilled",
  "gpsStatus": 3,
  "trackingNumber": "DHL1234567890",
  "carrier": "DHL",
  "fulfillmentId": "<fulfillment_id>"
}
```

---

### Scenario 3.2: UK GPS Order Fulfillment

**Description:** UK order fulfilled via GPS UK warehouse (H007).

```bash
# Using CLI
npm run flow:order -- --template ukGpsOrder --fulfill --tracking royalMail

# Or manually:
curl -X POST http://localhost:3100/state/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "id": "100002",
      "email": "jane.smith@example.co.uk",
      "firstName": "Jane",
      "lastName": "Smith"
    },
    "shippingAddress": {
      "address1": "45 Oxford Street",
      "city": "London",
      "province": "England",
      "country": "United Kingdom",
      "zip": "W1D 1BS",
      "countryCode": "GB"
    },
    "lineItems": [{
      "id": "1002",
      "sku": "IM8-FG-000020",
      "name": "IM8 Essential DNA Test",
      "quantity": 1,
      "price": "99.00"
    }],
    "dataAreaId": "H007"
  }'
```

**Validation Points:**

- `gpsUKOrderId` should be populated (not `gpsOrderId`)
- `dataAreaId` should be `H007`
- Carrier might be "Royal Mail" for UK orders
- Logistics channel should be UK-specific

---

### Scenario 3.3: Complete Flow with CLI

**Description:** End-to-end test using the CLI tool.

```bash
# US GPS order with fulfillment
npm run flow:order -- --template usGpsOrder --fulfill

# UK GPS order with Royal Mail tracking
npm run flow:order -- --template ukGpsOrder --fulfill --tracking royalMail

# US GPS order with FedEx
npm run flow:order -- --template usGpsOrder --fulfill --tracking fedex
```

**CLI Output Example:**

```
🚀 Starting Order Flow Simulation
   Template: usGpsOrder
   Fulfill: true

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

--- Step 4: Simulate GPS Fulfillment ---
📌 GPS Fulfillment
{
  "gpsStatus": 3,
  "trackingNumber": "DHL1234567890",
  "carrier": "DHL"
}

--- Step 5: Send Shopify orders/fulfilled Webhook ---
📌 Fulfillment Webhook Sent
{
  "success": true,
  "status": 200
}

✅ Order Flow Complete!
   Order: IM8-1001
   Final Status: fulfilled
```

---

### Scenario 3.4: GPS Fulfillment Script

**Description:** Use the dedicated GPS fulfillment CLI.

```bash
# Fulfill with default DHL tracking
npm run gps:fulfill -- --orderId IM8-1001

# Fulfill with custom tracking
npm run gps:fulfill -- --orderId IM8-1001 --tracking FEDEX123456 --carrier FedEx

# Fulfill with preset tracking info
npm run gps:fulfill -- --orderId IM8-1001 --preset royalMail
```

---

## GPS Status Codes

| Status | Meaning       | spock-store Action |
| ------ | ------------- | ------------------ |
| 0      | Created       | Skip               |
| 1      | Processing    | Skip               |
| 2      | Ready to Ship | Skip               |
| 3      | Shipped       | Create fulfillment |
| 4      | Delivered     | Already processed  |
| 5      | Exception     | Alert/investigate  |

---

## Validation Checklist

| Step | Check                         | Method                   |
| ---- | ----------------------------- | ------------------------ |
| 1    | Order created with GPS ID     | `GET /state/orders/:id`  |
| 2    | GPS returns status 3          | `POST /gps/.../detail`   |
| 3    | Tracking info present         | Check `logisticsTrackNo` |
| 4    | Shopify fulfillment created   | Check spock-store logs   |
| 5    | Dynamics fulfillment sent     | Check spock-store logs   |
| 6    | Order status = fulfilled      | `GET /state/orders/:id`  |
| 7    | Not re-processed on next poll | Run polling again        |

---

## Data Flow Details

### GPS Detail Response → spock-store Processing

```javascript
// GPS response for fulfilled order
{
  outboundOrderNo: "GPS1234ABCD",
  status: 3,                           // GPS_FULFILLED_STATUS
  logisticsTrackNo: "DHL1234567890",
  logisticsCarrier: "DHL",
  platformOrderNo: "IM8-1001",         // Shopify order name
  outboundTime: "2024-01-15T10:30:00Z"
}

// spock-store derives:
dataAreaId = (warehouse === 'GPS UK') ? 'H007' : 'U001'

// Builds ShopifyFulfilmentRequest:
{
  warehouse: 'dynamics',
  fulfilmentLines: salesOrder.salesOrderLine.map(...),
  trackingNumber: "DHL1234567890",
  carrier: "DHL"
}
```

### Exclusion Logic for Polling

Orders are **excluded** from GPS polling if:

1. Already fulfilled: `shopifyFulfilmentId IS NOT NULL`
2. Cancelled (dummy ID): `shopifyFulfilmentId = '00000000000000'`
3. No GPS order ID: `gpsOrderId IS NULL AND gpsUKOrderId IS NULL`

---

## Error Scenarios

### Error 3.1: GPS API Timeout

**Trigger:** GPS doesn't respond within timeout

**Expected Behavior:**

- Log timeout error
- Retry on next scheduled run
- Don't mark as failed

### Error 3.2: Missing Tracking Info

**Trigger:** GPS status=3 but `logisticsTrackNo` empty

**Expected Behavior:**

- Log warning
- May still create fulfillment with empty tracking
- Or skip until tracking available (depends on config)

### Error 3.3: Order Not Found in spock-store

**Trigger:** GPS returns `platformOrderNo` not matching any SalesOrder

**Expected Behavior:**

- Log warning
- Skip this order
- May need manual investigation

### Error 3.4: Duplicate Fulfillment Attempt

**Trigger:** Same order processed twice

**Expected Behavior:**

- Second attempt should be blocked by existence of `shopifyFulfilmentId`
- Shopify may also reject duplicate fulfillment

---

## Differences: US vs UK GPS

| Aspect            | US (U001)                         | UK (H007)                           |
| ----------------- | --------------------------------- | ----------------------------------- |
| Field             | `gpsOrderId`                      | `gpsUKOrderId`                      |
| Warehouse         | GPS US                            | GPS UK                              |
| Typical Carriers  | DHL, FedEx, UPS                   | Royal Mail, DHL, Hermes             |
| Logistics Channel | US-specific                       | UK-specific                         |
| Query Function    | `findSalesOrdersByUnfulfilledGps` | `findSalesOrdersByUnfulfilledGpsUK` |

---

## Notes

- GPS is **pull-based**: spock-store polls GPS, not the other way around
- Polling runs on a schedule (e.g., every 5-15 minutes)
- Orders are processed in batches for efficiency
- Status 3 is the trigger for fulfillment creation
- Always verify `outboundTime` is present before processing
- The `'00000000000000'` ID is reserved for cancelled orders to prevent re-polling
