# Flow 5: Refunds

> **Journey Name:** Shopify refund events affecting ERP + local fulfillment logic  
> **Direction:** Shopify → spock-store → Dynamics / Internal State

## Overview

This flow tests how Shopify refund events are processed by spock-store. Refunds can be partial or full, and must be carefully handled to avoid double-processing and to correctly update both the internal state and Dynamics ERP.

```
┌─────────────┐   refunds/create    ┌─────────────┐   Credit Note/Adjustment   ┌───────────────┐
│   Shopify   │ ──────────────────► │ spock-store │ ──────────────────────────► │  Dynamics 365 │
└─────────────┘     webhook         └─────────────┘                             └───────────────┘
                                           │
                                           │  Update SalesOrder
                                           │  Handle fulfillment state
                                           ▼
                                    ┌─────────────┐
                                    │ Internal DB │
                                    └─────────────┘
```

## Trigger Events

- Customer requests refund through Shopify
- Admin processes refund in Shopify
- Shopify fires `refunds/create` webhook

## Key Endpoints

| System | Direction | Endpoint | Description |
|--------|-----------|----------|-------------|
| Shopify → spock-store | Inbound | `POST /v1.0/shopify/webhook` | Receives refund webhook |
| spock-store → Dynamics | Outbound | (varies) | Credit notes/adjustments |

---

## Prerequisites

1. **Complete Flow 1** - Order must exist with:
   - Valid `shopifyOrderId`
   - `dynamicsSalesOrderNumber` populated
   - May or may not have fulfillment

2. **Start the simulator:**
   ```bash
   npm run dev
   ```

---

## Test Scenarios

### Scenario 5.1: Full Refund (Unfulfilled Order)

**Description:** Complete refund of an order that hasn't been shipped.

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

#### Step 2: Send Refund Webhook

```bash
curl -X POST http://localhost:3100/webhooks/shopify/refunds/create \
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
    "shopifyOrderName": "IM8-1001"
  },
  "refund": {
    "id": 1705331234567,
    "order_id": 12345678901234,
    "created_at": "2024-01-15T10:30:00.000Z",
    "note": "Refund processed",
    "processed_at": "2024-01-15T10:30:00.000Z",
    "refund_line_items": [{
      "id": 1705331234567,
      "quantity": 1,
      "line_item_id": 1001,
      "line_item": {
        "id": 1001,
        "sku": "IM8-FG-000010",
        "name": "IM8 Premium DNA Test",
        "quantity": 1,
        "price": "199.00"
      },
      "subtotal": 199.00
    }],
    "transactions": [{
      "id": 1705331234567,
      "order_id": 12345678901234,
      "kind": "refund",
      "gateway": "shopify_payments",
      "status": "success",
      "amount": "199.00"
    }],
    "order_adjustments": []
  },
  "webhook": {
    "success": true,
    "status": 200
  }
}
```

#### Step 3: Verify Order State

```bash
curl http://localhost:3100/state/orders/IM8-1001
```

**Expected:**
```json
{
  "status": "refunded",
  ...
}
```

---

### Scenario 5.2: Full Refund (Fulfilled Order)

**Description:** Refund of an order that has already been shipped.

#### Step 1: Create Order with Fulfillment

```bash
# Use CLI to create fulfilled order
npm run flow:order -- --template usGpsOrder --fulfill
```

#### Step 2: Send Refund Webhook

```bash
curl -X POST http://localhost:3100/webhooks/shopify/refunds/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "IM8-1001"
  }'
```

**Expected Behavior:**
- Order status changes to `refunded`
- Existing fulfillment remains (physical shipment occurred)
- Dynamics may receive credit note notification

---

### Scenario 5.3: Partial Refund

**Description:** Refund of some but not all items/quantity.

#### Step 1: Create Multi-Item Order

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

# Pay the order
curl -X POST http://localhost:3100/webhooks/shopify/orders/paid \
  -H "Content-Type: application/json" \
  -d '{"orderId": "IM8-1001"}'
```

#### Step 2: Send Partial Refund Webhook

The actual Shopify webhook payload for partial refund:

```json
{
  "id": 1705331234567,
  "order_id": 12345678901234,
  "created_at": "2024-01-15T10:30:00.000Z",
  "note": "Partial refund - customer changed mind on 1 item",
  "processed_at": "2024-01-15T10:30:00.000Z",
  "refund_line_items": [{
    "id": 1705331234567,
    "quantity": 1,
    "line_item_id": 1001,
    "line_item": {
      "id": 1001,
      "sku": "IM8-FG-000010",
      "name": "Item 1",
      "quantity": 2,
      "price": "99.00"
    },
    "subtotal": 99.00
  }],
  "transactions": [{
    "id": 1705331234567,
    "order_id": 12345678901234,
    "kind": "refund",
    "gateway": "shopify_payments",
    "status": "success",
    "amount": "99.00"
  }],
  "order_adjustments": []
}
```

**Expected Behavior:**
- Only refunded line items processed
- Remaining items still fulfillable
- Order status may remain `processing` or become `partially_refunded`

---

### Scenario 5.4: Refund with Restock

**Description:** Refund where items are restocked to inventory.

```json
{
  "id": 1705331234567,
  "order_id": 12345678901234,
  "refund_line_items": [{
    "id": 1705331234567,
    "quantity": 1,
    "line_item_id": 1001,
    "restock_type": "return",
    "location_id": 61813039173,
    "line_item": { ... }
  }],
  ...
}
```

**Expected Behavior:**
- Item marked for restocking
- Inventory adjustment may be needed in WMS/Dynamics

---

### Scenario 5.5: Full Flow with CLI

```bash
# Create fulfilled order then refund
npm run flow:order -- --template usGpsOrder --fulfill --refund
```

**CLI Output:**
```
--- Step 5: Refund Order ---
📌 Refund Webhook Sent
{
  "success": true,
  "status": 200
}

--- Final Order State ---
{
  "status": "refunded",
  "trackingNumber": "DHL1234567890",
  "fulfillmentId": "<id>"
}

✅ Order Flow Complete!
   Order: IM8-1001
   Final Status: refunded
```

---

## Shopify Refund Webhook Payload

### Full Schema

```typescript
interface ShopifyRefund {
  id: number;
  order_id: number;
  created_at: string;           // ISO 8601
  note: string | null;
  user_id: number | null;
  processed_at: string;         // ISO 8601
  restock: boolean;
  admin_graphql_api_id: string;
  
  refund_line_items: RefundLineItem[];
  transactions: RefundTransaction[];
  order_adjustments: OrderAdjustment[];
  duties: RefundDuty[];
}

interface RefundLineItem {
  id: number;
  quantity: number;
  line_item_id: number;
  location_id: number | null;
  restock_type: 'no_restock' | 'cancel' | 'return' | 'legacy_restock';
  subtotal: number;
  subtotal_set: MoneySet;
  total_tax: number;
  total_tax_set: MoneySet;
  line_item: LineItem;
}

interface RefundTransaction {
  id: number;
  order_id: number;
  kind: 'refund';
  gateway: string;
  status: 'pending' | 'success' | 'failure' | 'error';
  message: string | null;
  created_at: string;
  amount: string;              // Decimal string
  currency: string;
  receipt: object;
  authorization: string | null;
}
```

---

## spock-store Processing Logic

### processRefund Flow

```javascript
async function processRefund(detail: ShopifyRefundDetail) {
  // 1. Find associated SalesOrder
  const salesOrder = await findByShopifyOrderId(detail.order_id);
  
  // 2. Check if partial or full refund
  const isFullRefund = detail.refund_line_items.length === salesOrder.lineItems.length
    && allQuantitiesMatch(detail, salesOrder);
  
  // 3. Update internal state
  if (isFullRefund) {
    salesOrder.status = 'refunded';
  } else {
    salesOrder.status = 'partially_refunded';
  }
  
  // 4. Handle fulfillment logic
  // - Don't create "dummy" refund fulfillments
  // - Distinguish actual shipments from refund entries
  
  // 5. Notify Dynamics if needed
  if (config.notifyDynamicsOnRefund) {
    await createDynamicsCreditNote(salesOrder, detail);
  }
  
  // 6. Update Fulfilment entities
  // - Mark refunded items
  // - Update quantities
}
```

---

## Validation Checklist

| Step | Check | Method |
|------|-------|--------|
| 1 | Refund webhook received | Check spock-store logs |
| 2 | SalesOrder found | Query by order_id |
| 3 | Refund type identified | Partial vs full |
| 4 | Order status updated | Check internal DB |
| 5 | Dynamics notified (if applicable) | Check Dynamics API call |
| 6 | Not double-processed | Send same webhook twice |
| 7 | GPS polling excludes refunded orders | Check polling logic |

---

## Error Scenarios

### Error 5.1: Order Not Found

**Trigger:** Refund webhook for unknown order

**Expected Behavior:**
- Log warning
- Return acknowledgment
- May create placeholder for investigation

### Error 5.2: Already Refunded

**Trigger:** Refund webhook for already-refunded order

**Expected Behavior:**
- Check idempotency
- Skip if already processed
- Log duplicate detection

### Error 5.3: Partial Refund Math Mismatch

**Trigger:** Refund quantities don't match line items

**Expected Behavior:**
- Log warning
- Process what's possible
- Alert for manual review

---

## Interaction with Other Flows

### With GPS Polling (Flow 3)

Orders with refunds may need special handling in GPS queries:

```sql
-- Exclude fully refunded orders from GPS polling
SELECT * FROM SalesOrder
WHERE gpsOrderId IS NOT NULL
  AND status != 'refunded'
  AND (Fulfilment.shopifyFulfilmentId IS NULL 
       OR Fulfilment.shopifyFulfilmentId != '00000000000000')
```

### With Cancellations (Flow 6)

- Refunds ≠ Cancellations (though they may occur together)
- Cancellation creates dummy fulfillment ID
- Refund updates financial status

### With Fulfillment Flows

- Refund on fulfilled order: fulfillment remains, only financial status changes
- Refund on unfulfilled order: may trigger cancellation of GPS/WMS order

---

## Edge Cases

### Dummy SKU Refunds

Some refunds may contain "dummy" SKUs for adjustments:

```json
{
  "refund_line_items": [{
    "line_item": {
      "sku": "ADJUSTMENT-FEE",
      "name": "Price Adjustment",
      "price": "-10.00"
    }
  }]
}
```

**Handling:** Skip dummy SKUs in fulfillment logic.

### Refund-Only Fulfillments

Shopify may create "fulfillments" that are actually refund markers. Don't confuse these with real shipments:

```javascript
// Check for dummy/refund fulfillments
const isRealFulfillment = fulfillment.tracking_number 
  && fulfillment.tracking_number !== ''
  && !fulfillment.tracking_number.startsWith('REFUND-');
```

---

## Slack Alerts

Refund processing may trigger Slack alerts for:

- Large refund amounts (> $X)
- Refunds on recent orders (< 24 hours old)
- Multiple refunds for same customer
- Refund processing errors

---

## Notes

- Careful with **partial refunds** - distinguish shipped vs refunded fulfillments
- Avoid **double-processing** with idempotency checks
- **Dummy refund fulfillments** should not trigger GPS polling exclusion
- Refunds interact with Prive/Europa for subscription orders
- Consider timezone when comparing `processed_at` timestamps

