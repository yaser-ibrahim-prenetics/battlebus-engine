# End-to-End Testing Guide

## Battle Bus & Battle Hub Integration Testing

This document provides comprehensive end-to-end testing procedures for all integrations between:
- **Shopify** (E-commerce)
- **Battle Bus** (Integration Mesh)
- **Battle Hub** (Customer Service Portal)
- **Dynamics 365** (ERP)
- **GPS Warehouse** (3PL)
- **Extensiv** (3PL/WMS)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Test Environment Setup](#test-environment-setup)
3. [Order Flows](#order-flows)
4. [Inventory Flows](#inventory-flows)
5. [Product Flows](#product-flows)
6. [Battle Hub Actions](#battle-hub-actions)
7. [Webhook Testing](#webhook-testing)
8. [Verification & Monitoring](#verification--monitoring)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Access

- **Shopify Admin**: Access to test store (im8-store.myshopify.com)
- **Dynamics 365**: API access with valid credentials
- **GPS Warehouse**: API credentials for test warehouse
- **Extensiv**: Webhook endpoint access (if applicable)
- **Battle Hub**: Admin access to customer service portal
- **Inngest Dashboard**: Access to function runs and logs

### Required Tools

- **Postman/curl**: For API testing
- **Shopify Admin**: For order/product management
- **Dynamics 365**: For verifying sales orders
- **Inngest Dashboard**: http://localhost:8288 (local) or cloud dashboard
- **Browser DevTools**: For network monitoring
- **Terminal**: For running test scripts

### Environment Variables

Ensure all required environment variables are set:

```bash
# Battle Bus
SHOPIFY_ACCESS_TOKEN=...
SHOPIFY_SHOP_DOMAIN=im8-store.myshopify.com
DYNAMICS_CLIENT_ID=...
DYNAMICS_CLIENT_SECRET=...
DYNAMICS_TENANT_ID=...
GPS_API_KEY=...
GPS_API_SECRET=...
INNGEST_EVENT_KEY=...

# Battle Hub
BATTLE_BUS_URL=https://battle-bus.vercel.app
BATTLE_BUS_WEBHOOK_SECRET=...
```

---

## Test Environment Setup

### 1. Start Local Services

```bash
# Terminal 1: Battle Bus
cd battle-bus-inngest
npm run dev:all  # Starts Next.js (port 7000) + Inngest (port 8288)

# Terminal 2: Battle Hub (if testing locally)
cd battle-cs
npm run dev  # Starts on port 3000
```

**Important**: After making code changes, restart the dev server or wait for Next.js to recompile. If you see errors about old code paths, restart the server:
```bash
# Stop the server (Ctrl+C) and restart
npm run dev:all
```

### 2. Verify Services

```bash
# Check Battle Bus health
curl http://localhost:7000/api/inventory/sync

# Check Inngest dashboard
open http://localhost:8288

# Check Battle Hub
open http://localhost:3000
```

### 3. Test Data Preparation

- **Test Products**: Create test products in Shopify with known SKUs
- **Test Customer**: Use test customer account
- **Test Orders**: Use test order numbers (e.g., IM8-TEST-001)
- **Test Locations**: Use known location IDs (GPS US: 79527313640, GPS UK: 82997936360)

---

## Order Flows

### Test 1: Order Creation & Payment Flow

**Flow**: Shopify → Battle Bus → Dynamics 365 → GPS Warehouse

#### Prerequisites
- Test product exists in Shopify
- Customer account exists
- GPS warehouse API accessible

#### Test Steps

1. **Create Order in Shopify**
   ```bash
   # Via Shopify Admin or API
   # Order should have:
   # - Test product with known SKU
   # - Shipping address
   # - Payment status: paid
   ```

2. **Trigger Webhook** (if not automatic)
   ```bash
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "Content-Type: application/json" \
     -H "x-shopify-topic: orders/paid" \
     -H "x-shopify-shop-domain: im8-store.myshopify.com" \
     -H "x-shopify-webhook-id: test-$(date +%s)" \
     -d @test-order-payload.json
   ```

3. **Verify Inngest Event**
   - Open http://localhost:8288
   - Check for `shopify/order.created` event
   - Verify function `process-shopify-order` is triggered

4. **Verify Dynamics 365**
   - Check Dynamics 365 for new Sales Order
   - Verify order number format: `U001-SO-XXXXXX`
   - Verify line items match Shopify order
   - Verify customer information

5. **Verify GPS Warehouse**
   - Check GPS API for outbound order
   - Verify GPS order ID is created
   - Verify order status in GPS system

6. **Verify Shopify Metafields**
   - Check order metafields for:
     - `d365_order_number`
     - `gps_order_id` or `gps_uk_order_id`
     - `warehouse_name`

#### Expected Results

- ✅ Order appears in Inngest dashboard
- ✅ Sales Order created in Dynamics 365
- ✅ Outbound order created in GPS
- ✅ Metafields set on Shopify order
- ✅ Order visible in Battle Hub

#### Verification Commands

```bash
# Check Inngest function run
curl "http://localhost:8288/api/v1/runs?function_id=process-shopify-order"

# Check Dynamics order (via API)
curl -X GET "https://<dynamics-url>/data/SalesOrderHeadersV3?\$filter=SalesOrderNumber eq 'U001-SO-XXXXXX'" \
  -H "Authorization: Bearer $DYNAMICS_TOKEN"

# Check GPS order
curl -X GET "https://<gps-url>/openapi/v1/outboundOrder/get?orderId=<gps-order-id>" \
  -H "Authorization: Bearer $GPS_TOKEN"
```

---

### Test 2: GPS Fulfillment Flow

**Flow**: GPS Warehouse → Battle Bus → Shopify → Dynamics 365

#### Prerequisites
- Order exists in GPS with status = 3 (fulfilled)
- Order has tracking information
- GPS webhook endpoint configured

#### Test Steps

1. **Simulate GPS Fulfillment**
   ```bash
   # Option 1: Use GPS webhook
   curl -X POST "http://localhost:7000/api/webhooks/gps" \
     -H "Content-Type: application/json" \
     -d '{
       "orderId": "<gps-order-id>",
       "status": 3,
       "trackingNumber": "TEST123456789",
       "carrier": "DHL"
     }'

   # Option 2: Use cron sync (runs every 5 minutes)
   # Wait for cron or trigger manually
   ```

2. **Verify Inngest Event**
   - Check for `gps/fulfilment.received` event
   - Verify function `process-gps-individual` is triggered

3. **Verify Shopify Fulfillment**
   - Check Shopify order for fulfillment
   - Verify tracking number matches GPS
   - Verify carrier information
   - Verify fulfillment status

4. **Verify Dynamics 365**
   - Check for fulfillment record
   - Verify tracking information synced

#### Expected Results

- ✅ Fulfillment created in Shopify
- ✅ Tracking number added to order
- ✅ Customer receives tracking email
- ✅ Fulfillment synced to Dynamics 365

---

### Test 3: Extensiv Fulfillment Flow

**Flow**: Extensiv → Battle Bus → Shopify → Dynamics 365

#### Test Steps

1. **Send Extensiv Webhook**
   ```bash
   curl -X POST "http://localhost:7000/api/webhooks/extensiv" \
     -H "Content-Type: application/json" \
     -d '{
       "eventType": "outbound.shipped",
       "orderId": "<extensiv-order-id>",
       "shopifyOrderName": "IM8-TEST-001",
       "trackingNumber": "EXT123456789",
       "carrier": "UPS"
     }'
   ```

2. **Verify Processing**
   - Check Inngest for `extensiv/order.confirm` event
   - Verify function `process-extensiv-fulfillment` runs

3. **Verify Shopify & Dynamics**
   - Same as GPS fulfillment verification

---

### Test 4: Order Cancellation Flow

**Flow**: Battle Hub → Battle Bus → Shopify → Dynamics 365

#### Test Steps

1. **Cancel Order via Battle Hub**
   - Open Battle Hub
   - Navigate to order
   - Click "Cancel Order"
   - Enter cancellation reason
   - Submit

2. **Verify API Call**
   ```bash
   # Check Battle Bus logs for:
   POST /api/actions/cancel
   {
     "orderName": "IM8-TEST-001",
     "reason": "customer_request",
     "email": true,
     "refund": false
   }
   ```

3. **Verify Shopify**
   - Check order cancellation status
   - Verify cancellation reason
   - Verify customer email sent (if enabled)

4. **Verify Dynamics 365**
   - Check for cancellation record
   - Verify order status updated

#### Expected Results

- ✅ Order cancelled in Shopify
- ✅ Cancellation reason recorded
- ✅ Customer notified (if enabled)
- ✅ Dynamics 365 updated

---

### Test 5: Order Refund Flow

**Flow**: Battle Hub → Battle Bus → Shopify → Dynamics 365

#### Test Steps

1. **Refund Order via Battle Hub**
   - Open order in Battle Hub
   - Click "Refund"
   - Select refund type:
     - Full refund
     - Partial refund (amount)
     - Line item refund
   - Set restock option
   - Submit

2. **Verify API Call**
   ```bash
   # Check Battle Bus logs for:
   POST /api/actions/refund
   {
     "orderName": "IM8-TEST-001",
     "amount": 100.00,
     "reason": "customer_request",
     "refundLineItems": [...],
     "restock": true,
     "location_id": 79527313640
   }
   ```

3. **Verify Shopify**
   - Check refund record
   - Verify refund amount
   - Verify restock (if enabled)
   - Verify customer notification

4. **Verify Dynamics 365**
   - Check for credit note
   - Verify refund amount
   - Verify line items

#### Expected Results

- ✅ Refund processed in Shopify
- ✅ Credit note created in Dynamics 365
- ✅ Inventory restocked (if enabled)
- ✅ Customer notified

---

### Test 6: Order Fulfillment via Battle Hub

**Flow**: Battle Hub → Battle Bus → Shopify → Dynamics 365

#### Test Steps

1. **Fulfill Order via Battle Hub**
   - Open order in Battle Hub
   - Click "Fulfill"
   - Select fulfillment type:
     - **Manual**: Enter tracking number and carrier
     - **GPS**: System fetches from GPS automatically
   - Select line items to fulfill
   - Submit

2. **Verify API Call**
   ```bash
   # Manual fulfillment
   POST /api/actions/fulfillment
   {
     "orderName": "IM8-TEST-001",
     "fulfillmentType": "manual",
     "trackingNumber": "TEST123456789",
     "carrier": "UPS",
     "lineItems": [...]
   }

   # GPS fulfillment
   POST /api/actions/fulfillment
   {
     "orderName": "IM8-TEST-001",
     "fulfillmentType": "gps"
   }
   ```

3. **Verify Processing**
   - For GPS: System fetches tracking from GPS API
   - For Manual: Uses provided tracking info
   - Creates fulfillment in Shopify
   - Syncs to Dynamics 365

#### Expected Results

- ✅ Fulfillment created in Shopify
- ✅ Tracking information added
- ✅ Customer notified
- ✅ Dynamics 365 updated

---

## Inventory Flows

### Test 7: Inventory Sync from Shopify

**Flow**: Shopify → Battle Bus → Dynamics 365 + GPS

#### Test Steps

1. **Update Inventory in Shopify**
   - Change inventory level for a product
   - Or trigger webhook manually:
   ```bash
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "x-shopify-topic: inventory_levels/update" \
     -H "x-shopify-shop-domain: im8-store.myshopify.com" \
     -d '{
       "inventory_item_id": 123456789,
       "location_id": 79527313640,
       "available": 100
     }'
   ```

2. **Verify Mesh Routing**
   - Check Inngest for `inventory/sync` events
   - Verify events sent to both Dynamics and GPS

3. **Verify Dynamics 365**
   - Check inventory levels updated
   - Verify location mapping correct

4. **Verify GPS**
   - Check GPS inventory updated
   - Verify SKU mapping correct

#### Expected Results

- ✅ Inventory synced to Dynamics 365
- ✅ Inventory synced to GPS
- ✅ Location mapping correct
- ✅ SKU mapping correct

---

### Test 8: Inventory Sync Mesh API

**Flow**: Any Source → Battle Bus → Any Destination

#### Test Steps

1. **Sync from Shopify to Dynamics**
   ```bash
   curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics" \
     -H "Content-Type: application/json" \
     -d '{
       "sku": "TEST-SKU-001",
       "inventoryItemId": "123456789",
       "locationId": "79527313640",
       "quantity": 100,
       "action": "update"
     }'
   ```

2. **Sync from Warehouse to Shopify**
   ```bash
   curl -X POST "http://localhost:7000/api/inventory/sync?from=warehouse&to=shopify" \
     -H "Content-Type: application/json" \
     -d '{
       "sku": "TEST-SKU-001",
       "available": 75,
       "warehouseId": "GPS-US",
       "action": "update"
     }'
   ```

3. **Sync to Multiple Destinations**
   ```bash
   curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics,gps" \
     -H "Content-Type: application/json" \
     -d '{
       "sku": "TEST-SKU-001",
       "quantity": 200,
       "locationId": "79527313640",
       "action": "update"
     }'
   ```

#### Expected Results

- ✅ API returns success (200 or 202)
- ✅ Events sent to Inngest
- ✅ Inventory synced to destination(s)
- ✅ Error handling works (if Inngest unavailable)

---

## Product Flows

### Test 9: Product Creation

**Flow**: Shopify → Battle Bus → Dynamics 365 + GPS

#### Test Steps

1. **Create Product in Shopify**
   - Create new product with variants
   - Set SKU, price, barcode, weight
   - Save product

2. **Trigger Webhook**
   ```bash
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "x-shopify-topic: products/create" \
     -H "x-shopify-shop-domain: im8-store.myshopify.com" \
     -d @test-product-payload.json
   ```

3. **Verify Processing**
   - Check Inngest for `shopify/product.created` event
   - Verify function `process-product-sync` runs

4. **Verify Dynamics 365**
   - Check for new product/item
   - Verify SKU mapping
   - Verify price and weight

5. **Verify GPS**
   - Check for product in GPS
   - Verify SKU and barcode

#### Expected Results

- ✅ Product synced to Dynamics 365
- ✅ Product synced to GPS
- ✅ All variant data synced
- ✅ SKU mapping correct

---

### Test 10: Product Update

**Flow**: Shopify → Battle Bus → Dynamics 365 + GPS

#### Test Steps

1. **Update Product in Shopify**
   - Change price, weight, or other attributes
   - Save changes

2. **Verify Sync**
   - Same verification as product creation
   - Check that updates are reflected

---

### Test 11: Product Deletion

**Flow**: Shopify → Battle Bus → Dynamics 365 + GPS

#### Test Steps

1. **Delete Product in Shopify**
   - Delete product from Shopify admin

2. **Trigger Webhook**
   ```bash
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "x-shopify-topic: products/delete" \
     -H "x-shopify-shop-domain: im8-store.myshopify.com" \
     -d '{"id": 123456789, "title": "Deleted Product"}'
   ```

3. **Verify Processing**
   - Check Inngest for `shopify/product.deleted` event
   - Verify deletion in Dynamics 365
   - Verify deletion in GPS

#### Expected Results

- ✅ Product deleted from Dynamics 365
- ✅ Product deleted from GPS
- ✅ No orphaned records

---

## Battle Hub Actions

### Test 12: Bulk Operations

#### Test Steps

1. **Bulk Cancel Orders**
   - Select multiple orders in Battle Hub
   - Click "Bulk Cancel"
   - Enter reason
   - Submit

2. **Bulk Refund Orders**
   - Select multiple orders
   - Click "Bulk Refund"
   - Enter amount and reason
   - Submit

3. **Verify Processing**
   - Check each order processed individually
   - Verify all orders updated
   - Check for any failures

#### Expected Results

- ✅ All selected orders processed
- ✅ Individual API calls made for each
- ✅ Failures logged but don't block others
- ✅ Status updated in Battle Hub

---

## Webhook Testing

### Test 13: Shopify Webhook Verification

#### Test Steps

1. **Test HMAC Verification**
   ```bash
   # Valid signature
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "x-shopify-hmac-sha256: <valid-signature>" \
     -H "x-shopify-topic: orders/create" \
     -d @test-payload.json

   # Invalid signature (should fail)
   curl -X POST "http://localhost:7000/api/webhooks/shopify" \
     -H "x-shopify-hmac-sha256: invalid" \
     -H "x-shopify-topic: orders/create" \
     -d @test-payload.json
   ```

2. **Test All Webhook Topics**
   - `orders/create`
   - `orders/paid`
   - `orders/updated`
   - `orders/cancelled`
   - `orders/fulfilled`
   - `refunds/create`
   - `products/create`
   - `products/update`
   - `products/delete`
   - `inventory_levels/update`

#### Expected Results

- ✅ Valid signatures accepted
- ✅ Invalid signatures rejected (401)
- ✅ All topics processed correctly
- ✅ Events sent to Inngest

---

## Verification & Monitoring

### Inngest Dashboard

**URL**: http://localhost:8288 (local) or cloud dashboard

**What to Check**:
- Function runs and status
- Event history
- Retry attempts
- Error logs
- Function execution time

### Battle Bus Logs

```bash
# Check Next.js logs
# Look for:
- [Webhook] Received Shopify webhook
- [InventorySync] Processing inventory update
- [ProductSync] Syncing product to D365
- [Actions] Order cancelled via Battle Bus
```

### Shopify Verification

```bash
# Check order metafields
curl -X GET "https://<shop>.myshopify.com/admin/api/2024-01/orders/<order-id>.json" \
  -H "X-Shopify-Access-Token: $TOKEN" | jq '.order.metafields'

# Check fulfillments
curl -X GET "https://<shop>.myshopify.com/admin/api/2024-01/orders/<order-id>/fulfillments.json" \
  -H "X-Shopify-Access-Token: $TOKEN"
```

### Dynamics 365 Verification

```bash
# Check sales order
curl -X GET "https://<dynamics-url>/data/SalesOrderHeadersV3?\$filter=SalesOrderNumber eq '<order-number>'" \
  -H "Authorization: Bearer $TOKEN"

# Check credit note (for refunds)
curl -X GET "https://<dynamics-url>/data/CreditNotes?\$filter=SalesOrderNumber eq '<order-number>'" \
  -H "Authorization: Bearer $TOKEN"
```

### GPS Verification

```bash
# Check outbound order
curl -X GET "https://<gps-url>/openapi/v1/outboundOrder/get?orderId=<gps-order-id>" \
  -H "Authorization: Bearer $GPS_TOKEN"

# Check order status
curl -X GET "https://<gps-url>/openapi/v1/outboundOrder/status?orderId=<gps-order-id>" \
  -H "Authorization: Bearer $GPS_TOKEN"
```

---

## Troubleshooting

### Common Issues

#### 1. Webhook Not Received

**Symptoms**: No event in Inngest dashboard

**Solutions**:
- Check webhook URL is correct
- Verify HMAC signature
- Check Battle Bus logs for errors
- Verify webhook is enabled in Shopify

#### 2. Inngest Function Not Triggered

**Symptoms**: Event received but function not running

**Solutions**:
- Check function is registered in `index.ts`
- Verify event name matches function trigger
- Check Inngest dashboard for errors
- Verify Inngest dev server is running (local)

#### 3. Dynamics 365 Sync Failed

**Symptoms**: Order not created in D365

**Solutions**:
- Check Dynamics API credentials
- Verify dataAreaId is correct
- Check D365 logs for errors
- Verify order format matches D365 requirements

#### 4. GPS Order Not Created

**Symptoms**: No GPS order ID in Shopify metafields

**Solutions**:
- Check GPS API credentials
- Verify warehouse mapping
- Check GPS API response for errors
- Verify product SKU exists in GPS

#### 5. Inventory Sync Not Working

**Symptoms**: Inventory not updating in destination

**Solutions**:
- Check mesh API response
- Verify SKU mapping
- Check location/warehouse mapping
- Verify Inngest events are being processed

#### 6. Battle Hub Actions Failing

**Symptoms**: Cancel/Refund/Fulfill not working

**Solutions**:
- Check Battle Bus API is accessible
- Verify order name/ID is correct
- Check API response for errors
- Verify Battle Hub can reach Battle Bus

### Debug Commands

```bash
# Test Battle Bus health
curl http://localhost:7000/api/inventory/sync

# Test Inngest connection
curl http://localhost:8288/api/v1/health

# Check function registration
curl http://localhost:8288/api/v1/functions

# View recent runs
curl http://localhost:8288/api/v1/runs?limit=10

# Test webhook endpoint
curl -X POST http://localhost:7000/api/webhooks/shopify \
  -H "x-shopify-topic: orders/create" \
  -d '{"test": true}'
```

---

## Test Checklist

### Order Flows
- [ ] Order creation (Shopify → D365 → GPS)
- [ ] GPS fulfillment (GPS → Shopify → D365)
- [ ] Extensiv fulfillment (Extensiv → Shopify → D365)
- [ ] Order cancellation (Battle Hub → Shopify → D365)
- [ ] Order refund (Battle Hub → Shopify → D365)
- [ ] Manual fulfillment (Battle Hub → Shopify → D365)
- [ ] GPS fulfillment via Battle Hub

### Inventory Flows
- [ ] Inventory sync from Shopify (Shopify → D365 + GPS)
- [ ] Inventory sync from warehouse (Warehouse → Shopify)
- [ ] Inventory sync mesh API (any → any)
- [ ] Multi-destination sync

### Product Flows
- [ ] Product creation (Shopify → D365 + GPS)
- [ ] Product update (Shopify → D365 + GPS)
- [ ] Product deletion (Shopify → D365 + GPS)

### Battle Hub Actions
- [ ] Single order cancel
- [ ] Single order refund
- [ ] Single order fulfill
- [ ] Bulk cancel
- [ ] Bulk refund
- [ ] Order details fetch

### Webhooks
- [ ] Shopify webhook verification
- [ ] GPS webhook processing
- [ ] Extensiv webhook processing
- [ ] Webhook error handling

---

## Test Data Templates

### Test Order Payload

```json
{
  "id": 123456789,
  "name": "IM8-TEST-001",
  "email": "test@example.com",
  "created_at": "2026-02-08T10:00:00Z",
  "financial_status": "paid",
  "fulfillment_status": null,
  "total_price": "100.00",
  "currency": "USD",
  "line_items": [
    {
      "id": 987654321,
      "variant_id": 111222333,
      "title": "Test Product",
      "quantity": 1,
      "sku": "TEST-SKU-001",
      "price": "100.00",
      "product_id": 444555666
    }
  ],
  "shipping_address": {
    "first_name": "Test",
    "last_name": "Customer",
    "address1": "123 Test St",
    "city": "Test City",
    "province": "CA",
    "country": "US",
    "zip": "12345"
  }
}
```

### Test Inventory Payload

```json
{
  "sku": "TEST-SKU-001",
  "inventoryItemId": "123456789",
  "locationId": "79527313640",
  "quantity": 100,
  "available": 95,
  "action": "update",
  "reason": "Test inventory sync"
}
```

---

## Performance Testing

### Load Testing

```bash
# Test concurrent webhooks
for i in {1..10}; do
  curl -X POST "http://localhost:7000/api/webhooks/shopify" \
    -H "x-shopify-topic: orders/create" \
    -d @test-order-$i.json &
done
wait

# Test inventory sync mesh
for i in {1..50}; do
  curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics" \
    -H "Content-Type: application/json" \
    -d "{\"sku\": \"TEST-$i\", \"quantity\": $i}" &
done
wait
```

### Expected Performance

- **Webhook Processing**: < 1 second
- **Order Creation**: < 5 seconds (including D365 + GPS)
- **Inventory Sync**: < 2 seconds
- **Product Sync**: < 3 seconds
- **Battle Hub Actions**: < 3 seconds

---

## Conclusion

This guide covers all major integration flows. For specific test scenarios or edge cases, refer to individual flow documentation in `/docs/flows/`.

**Last Updated**: 2026-02-08
**Version**: 1.0.0

