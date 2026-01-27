# Flow 1: Order Creation & Payment

> **Journey Name:** IM8 Shopify order ingestion and downstream order creation  
> **Direction:** Shopify → battle-bus → Dynamics + WMS (Extensiv / GPS)

## Overview

This flow tests the complete order creation journey from when a customer places an order in Shopify through to sales order creation in Dynamics 365 and outbound order creation in the warehouse management system (GPS or Extensiv).

```
┌─────────────┐   orders/paid    ┌─────────────┐   POST SalesOrderHeadersV3     ┌───────────────┐
│   Shopify   │ ───────────────► │ battle-bus │ ─────────────────────────────► │  Dynamics 365 │
└─────────────┘    webhook       └─────────────┘                                └───────────────┘
                                        │
                                        │  POST /outboundOrder/create
                                        ▼
                                 ┌─────────────┐
                                 │  GPS / WMS  │
                                 └─────────────┘
```

## Trigger Events

- Customer places order in Shopify
- Shopify fires `orders/paid` webhook (primary trigger)
- Optional: `orders/create` webhook

## Key Endpoints

| System | Direction | Endpoint | Description |
|--------|-----------|----------|-------------|
| Shopify → battle-bus | Inbound | `POST /v1.0/shopify/webhook` | Receives order webhook |
| battle-bus → Dynamics | Outbound | `POST /data/SalesOrderHeadersV3` | Creates SO header |
| battle-bus → Dynamics | Outbound | `POST /data/SalesOrderLines` | Creates SO lines |
| battle-bus → GPS | Outbound | `POST /openapi/v1/outboundOrder/create` | Creates GPS order |

---

## Prerequisites

1. **Start the simulator:**
   ```bash
   cd /path/to/simulation
   npm run dev
   ```

2. **Configure battle-bus** to point to simulator:
   ```json
   {
     "shopify": { "baseUrl": "http://localhost:3100/shopify" },
     "dynamics": { "baseUrl": "http://localhost:3100/dynamics" },
     "gps": { "baseUrl": "http://localhost:3100/gps" }
   }
   ```

3. **Set environment variables:**
   ```bash
   export TARGET_WEBHOOK_URL=http://localhost:8080  # battle-bus URL
   export SHOPIFY_WEBHOOK_SECRET=your-secret
   ```

---

## Test Scenarios

### Scenario 1.1: US GPS Order (Basic Flow)

**Description:** Standard US customer order routed to GPS US warehouse.

#### Step 1: Create Simulated Order

```bash
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
```

**Expected Response:**
```json
{
  "id": "<uuid>",
  "shopifyOrderId": "<generated>",
  "shopifyOrderName": "IM8-1001",
  "status": "created",
  "dataAreaId": "U001"
}
```

#### Step 2: Send `orders/paid` Webhook

```bash
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001"
  }'
```

**Expected Response:**
```json
{
  "order": {
    "id": "<uuid>",
    "shopifyOrderId": "<id>",
    "shopifyOrderName": "IM8-1001"
  },
  "webhook": {
    "success": true,
    "status": 200
  }
}
```

#### Step 3: Verify battle-bus Processing

**What battle-bus should do:**
1. Parse webhook and validate HMAC signature
2. Create `Task` of type `shopify` with `topic: 'orders/paid'`
3. Fetch latest order from Shopify API (optional)
4. Call `createSalesOrder()` to create:
   - Dynamics SalesOrderHeader
   - Dynamics SalesOrderLines
   - GPS/Extensiv outbound order

#### Step 4: Verify State

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected Response (after battle-bus processing):**
```json
{
  "id": "<uuid>",
  "shopifyOrderName": "IM8-1001",
  "dynamicsSalesOrderNumber": "U001-SO-123456",
  "gpsOrderId": "GPS1234ABCD",
  "status": "processing",
  "gpsStatus": 1,
  "dataAreaId": "U001"
}
```

---

### Scenario 1.2: UK GPS Order

**Description:** UK customer order routed to GPS UK warehouse (H007).

```bash
# Using CLI
npm run flow:order -- --template ukGpsOrder

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
- `dataAreaId` should be `H007`
- GPS UK order ID stored in `gpsUKOrderId`
- Dynamics SalesOrderHeader contains UK-specific data

---

### Scenario 1.3: Multi-Item Order

**Description:** Order with multiple line items.

```bash
npm run flow:order -- --template multiItemOrder
```

**Validation Points:**
- All line items appear in Shopify webhook
- Dynamics creates SalesOrderLines for each item
- GPS receives all SKUs in the outbound order

---

## CLI Commands

```bash
# Quick US order test
npm run flow:order -- --template usGpsOrder

# UK order test
npm run flow:order -- --template ukGpsOrder

# Multi-item order
npm run flow:order -- --template multiItemOrder

# View help
npm run flow:order -- --help
```

---

## Validation Checklist

| Step | Check | Method |
|------|-------|--------|
| 1 | Order created in simulator | `GET /state/orders` |
| 2 | Webhook sent with correct headers | Check webhook response |
| 3 | battle-bus received webhook | Check battle-bus logs |
| 4 | Dynamics SO created | Check `dynamicsSalesOrderNumber` |
| 5 | GPS order created | Check `gpsOrderId` or `gpsUKOrderId` |
| 6 | Order status is `processing` | `GET /state/orders/:id` |

---

## Expected Data Transformations

### Shopify Order → Dynamics SalesOrderHeader

| Shopify Field | Dynamics Field |
|---------------|----------------|
| `name` (IM8-1001) | `THK_ShopifyReference` |
| `name` | `CustomerOrderReference` |
| `shipping_address.country_code` | `dataAreaId` (US→U001, GB→H007) |
| `customer.email` | Customer lookup |

### Shopify Order → GPS Outbound Order

| Shopify Field | GPS Field |
|---------------|-----------|
| `name` (IM8-1001) | `platformOrderNo` |
| Dynamics SO Number | `thirdOrderNo` |
| Line items | `skuList` |
| Address | `receiverInfo` |

---

## Error Scenarios

### Error 1.1: Invalid Webhook Signature

```bash
# Send webhook with wrong HMAC
curl -X POST http://localhost:8080/v1.0/shopify/webhook \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: invalid-signature" \
  -H "X-Shopify-Topic: orders/paid" \
  -d '{"id": 123}'
```

**Expected:** 401 Unauthorized

### Error 1.2: Dynamics API Failure

Simulate by stopping the Dynamics simulator or returning errors.

**Expected Behavior:** battle-bus should:
- Log error
- Retry (if configured)
- Not create GPS order until Dynamics succeeds

---

## Notes

- The `orders/paid` webhook is the primary trigger; `orders/create` is also handled
- battle-bus may refetch the order from Shopify API to get the latest state
- Dynamics order must be created before GPS order (need SO number)
- US orders use `dataAreaId: 'U001'`, UK orders use `H007`

