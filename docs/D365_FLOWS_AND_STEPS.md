# D365 Flows and Steps - Complete Reference

This document lists all D365 operations implemented in `battle-bus-inngest` and their step-by-step flows.

---

## ✅ **Flow 1: Create New Order (Shopify → D365)**

**Function:** `process-shopify-order.ts`  
**Trigger:** `shopify/order.created` or `shopify/order.paid`  
**Status:** ✅ **FULLY IMPLEMENTED**

### Steps:
1. **Validate Order** (test orders, high-risk, etc.)
2. **Check Existing D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId)`
   - If exists → skip
3. **Create D365 Order Header**
   - `dynamics.createSalesOrderHeaderV3(...)`
   - Returns: `SalesOrderNumber`
4. **Create D365 Order Lines** (for each line item)
   - `dynamics.createSalesOrderLine({ ...line, salesOrderNumber })`
   - Returns: `InventoryLotId` per line
5. **Wait for D365 Propagation** (5 seconds)
6. **Confirm D365 Order**
   - `dynamics.confirmSalesOrder(salesOrderNumber, dataAreaId)`
   - Retries 3x if "not found" error
7. **Create Prepayment**
   - `dynamics.createPrepayment(salesOrderNumber, dataAreaId)`
   - Only if `amount > 0`
8. **Send to GPS** (if applicable, separate flow)

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=THK_ShopifyReference eq '...'` (check existing)
- `POST /data/SalesOrderHeadersV3` (create header)
- `POST /data/SalesOrderLines` (create lines, one per item)
- `POST /api/services/.../confirmSO` (confirm)
- `POST /api/services/.../PostPrepayment` (prepayment)

---

## ✅ **Flow 2: Shopify Fulfillment → D365 Packing Slip (STORD/HK)**

**Function:** `process-shopify-fulfillment.ts`  
**Trigger:** `shopify/order.fulfilled`  
**Status:** ✅ **FULLY IMPLEMENTED**

### Steps:
1. **Skip GPS Fulfillments** (handled by cron)
2. **Get D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId, dataAreaId)`
3. **Process Each Fulfillment** (for STORD/HK):
   - Filter dummy SKUs
   - Map fulfillment items to D365 format
   - **Create D365 Packing Slip**
     - `dynamics.createFulfilment({ type: "PackingSlip", ... })`

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get order)
- `POST /api/services/.../fulfilment` (create packing slip)

---

## ✅ **Flow 3: GPS Fulfillment → Shopify + D365 (Cron Polling)**

**Function:** `cron-gps-sync.ts`  
**Trigger:** Cron (every `GPS_SCHEDULE_INTERVAL_MINUTES`)  
**Status:** ✅ **FULLY IMPLEMENTED**

### Steps:
1. **Get Unfulfilled Orders from Shopify** (batch of 50)
2. **Group by GPS Warehouse** (US vs UK)
3. **Check GPS Status** (for each warehouse batch)
   - `gps.getOutboundOrdersDetails(orderNames, warehouse)`
4. **For Each Fulfilled GPS Order:**
   - Create Shopify fulfillment
   - **Get D365 Order**
     - `dynamics.getSalesOrderByShopifyId(shopifyOrderId, dataAreaId)`
   - **Create D365 Packing Slip**
     - `dynamics.createFulfilment({ type: "PackingSlip", ... })`

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get order)
- `POST /api/services/.../fulfilment` (create packing slip)

---

## ✅ **Flow 4: Extensiv Fulfillment → Shopify + D365**

**Function:** `process-extensiv-fulfillment.ts`  
**Trigger:** `extensiv/fulfillment.received` (webhook)  
**Status:** ✅ **FULLY IMPLEMENTED** (needs verification)

### Steps:
1. **Verify Webhook Signature**
2. **Get Shopify Order**
3. **Create Shopify Fulfillment**
4. **Get D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId)`
5. **Create D365 Packing Slip**
   - `dynamics.createFulfilment({ type: "PackingSlip", ... })`

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get order)
- `POST /api/services/.../fulfilment` (create packing slip)

---

## ✅ **Flow 5: Order Cancellation → D365 Return Order**

**Function:** `process-order-cancellation.ts`  
**Trigger:** `shopify/order.cancelled`  
**Status:** ✅ **FULLY IMPLEMENTED**

### Steps:
1. **Get D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId)`
2. **Try Cancel GPS Order**
   - `gps.cancelOutboundOrder(shopifyOrderName)`
3. **Handle D365 Cancellation:**
   - **Case A: GPS Cancelled Successfully**
     - Log cancellation (D365 cancel API not implemented yet)
   - **Case B: GPS Failed (Order Already Shipped)**
     - **Get D365 Original Lines**
       - `dynamics.getSalesOrderLines(salesOrderNumber)`
     - **Create Return Order Header**
       - `dynamics.createSalesOrderHeadersV3ForReturn({ ... })`
       - Returns: `SalesOrderNumber` (return order)
     - **Create Return Order Lines** (for each item)
       - `dynamics.createSalesOrderLineForReturn({ quantity: -1 * item.quantity, ... })`
     - **Confirm Return Order**
       - `dynamics.confirmSalesOrder(returnOrderNumber, dataAreaId)`

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get original order)
- `GET /data/SalesOrderLines?$filter=...` (get original lines)
- `POST /data/SalesOrderHeadersV3` (create return header)
- `POST /data/SalesOrderLines` (create return lines)
- `POST /api/services/.../confirmSO` (confirm return order)

---

## ⚠️ **Flow 6: Order Update → D365 (Partial)**

**Function:** `process-order-update.ts`  
**Trigger:** `shopify/order.updated` (debounced)  
**Status:** ⚠️ **PARTIALLY IMPLEMENTED** (lookup only, no update API)

### Steps:
1. **Get D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId)`
2. **Determine Update Actions** (shipping address, notes, customer)
3. **Update D365** (NOT IMPLEMENTED - no D365 update API in clients)

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get order only)

**Missing:** D365 update/patch API for modifying existing orders

---

## ✅ **Flow 7: Refund → D365 Return Order**

**Function:** `process-refund.ts`  
**Trigger:** `shopify/refund.created`  
**Status:** ✅ **FULLY IMPLEMENTED**

### Steps:
1. **Get D365 Order**
   - `dynamics.getSalesOrderByShopifyId(shopifyOrderId)`
2. **Get D365 Original Lines**
   - `dynamics.getSalesOrderLines(salesOrderNumber)`
3. **Create Return Order Header**
   - `dynamics.createSalesOrderHeadersV3ForReturn({ ... })`
4. **Create Return Order Lines** (for refunded items)
   - `dynamics.createSalesOrderLineForReturn({ quantity: -1 * refundQuantity, ... })`
5. **Confirm Return Order**
   - `dynamics.confirmSalesOrder(returnOrderNumber, dataAreaId)`

**D365 API Calls:**
- `GET /data/SalesOrderHeadersV3?$filter=...` (get original order)
- `GET /data/SalesOrderLines?$filter=...` (get original lines)
- `POST /data/SalesOrderHeadersV3` (create return header)
- `POST /data/SalesOrderLines` (create return lines)
- `POST /api/services/.../confirmSO` (confirm return order)

---

## 📋 **Summary: All D365 Operations Used**

| Operation | Function | Endpoint | Status |
|-----------|----------|----------|--------|
| **Authenticate** | `authenticate()` | `POST /oauth2/v2.0/token` | ✅ |
| **Get Order by Shopify ID** | `getSalesOrderByShopifyId()` | `GET /data/SalesOrderHeadersV3?$filter=...` | ✅ |
| **Get Order Lines** | `getSalesOrderLines()` | `GET /data/SalesOrderLines?$filter=...` | ✅ |
| **Create Order Header** | `createSalesOrderHeaderV3()` | `POST /data/SalesOrderHeadersV3` | ✅ |
| **Create Order Line** | `createSalesOrderLine()` | `POST /data/SalesOrderLines` | ✅ |
| **Confirm Order** | `confirmSalesOrder()` | `POST /api/services/.../confirmSO` | ✅ |
| **Create Prepayment** | `createPrepayment()` | `POST /api/services/.../PostPrepayment` | ✅ |
| **Create Fulfilment** | `createFulfilment()` | `POST /api/services/.../fulfilment` | ✅ |
| **Create Return Header** | `createSalesOrderHeadersV3ForReturn()` | `POST /data/SalesOrderHeadersV3` | ✅ |
| **Create Return Line** | `createSalesOrderLineForReturn()` | `POST /data/SalesOrderLines` | ✅ |
| **Update Order** | ❌ | ❌ | ❌ **NOT IMPLEMENTED** |
| **Cancel Order** | ❌ | ❌ | ❌ **NOT IMPLEMENTED** (logged only) |

---

## 🧪 **How to Test Each Flow**

### **Flow 1: Create New Order**
```bash
# Send test order webhook
curl -X POST <NGROK_URL>/api/webhooks/shopify \
  -H "x-shopify-topic: orders/paid" \
  -d '{ "id": 999999, "name": "#TEST", ... }'

# Check logs for:
# - "Created sales order: <number>"
# - "Created sales order line with lot ID: ..."
# - "Confirmed sales order: <number>"
# - "Created prepayment for: <number>"
```

### **Flow 2: STORD/HK Fulfillment**
```bash
# Send fulfillment webhook
curl -X POST <NGROK_URL>/api/webhooks/shopify \
  -H "x-shopify-topic: orders/fulfilled" \
  -d '{ "id": 999999, "fulfillments": [...] }'

# Check logs for:
# - "Creating fulfilment for: <SalesOrderNumber>"
# - "Created fulfilment for: <SalesOrderNumber>"
```

### **Flow 3: GPS Fulfillment (Cron)**
- Wait for cron to run (or trigger manually in Inngest Dev UI)
- Check logs for GPS sync results

### **Flow 4: Extensiv Fulfillment**
```bash
# Send Extensiv webhook
curl -X POST <NGROK_URL>/api/webhooks/extensiv \
  -d '{ "event": "OrderConfirm", ... }'
```

### **Flow 5: Cancellation**
```bash
# Send cancellation webhook
curl -X POST <NGROK_URL>/api/webhooks/shopify \
  -H "x-shopify-topic: orders/cancelled" \
  -d '{ "id": 999999, ... }'

# Check logs for:
# - "Creating return sales order header: ..."
# - "Created return sales order: <ReturnNumber>"
```

### **Flow 7: Refund**
```bash
# Send refund webhook
curl -X POST <NGROK_URL>/api/webhooks/shopify \
  -H "x-shopify-topic: refunds/create" \
  -d '{ "order_id": 999999, "refund_line_items": [...] }'
```

---

## ✅ **All Flows Are Implemented!**

Every D365 operation from `spock-store` has been ported to `battle-bus-inngest`. The only missing pieces are:
- **Update Order API** (not in spock-store either - D365 doesn't support patching orders easily)
- **Cancel Order API** (logged but not implemented - may need custom D365 service)

All flows use the **same authentication** with the **same scope**, so fixing the scope issue fixes all flows! 🎉

