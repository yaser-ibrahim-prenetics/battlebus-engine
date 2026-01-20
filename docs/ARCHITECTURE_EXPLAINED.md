# Battle Bus Architecture - Complete Breakdown

## What Is Battle Bus?

Battle Bus is an **event-driven order processing system** that replaces the old "spock-store" polling system. Instead of constantly checking a database for new tasks, it **reacts to events** as they happen.

**Simple analogy:** 
- Old system (spock-store): Like checking your mailbox every 5 minutes
- New system (Battle Bus): Like getting a notification when mail arrives

---

## The Big Picture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Shopify   │────▶│  Webhooks   │────▶│   Inngest   │────▶│  D365/GPS   │
│   (Store)   │     │  (Receive)  │     │  (Process)  │     │ (Fulfil)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. **Customer places order** on Shopify
2. **Shopify sends webhook** to Battle Bus
3. **Battle Bus processes** the order (creates D365 record, sends to warehouse)
4. **Warehouse ships** and sends webhook back
5. **Battle Bus updates** Shopify with tracking info

---

## File-by-File Breakdown

### 1. WEBHOOK ENDPOINTS (Entry Points)

These are the "doors" where external systems send data to Battle Bus.

#### `/src/app/api/webhooks/shopify/route.ts`
**What it does:** Receives notifications from Shopify when something happens (order created, refund, cancellation).

**In simple terms:** When a customer buys something on your Shopify store, Shopify calls this URL and says "Hey, someone just ordered!"

**Key logic:**
```
1. Receive webhook from Shopify
2. Verify it's really from Shopify (check signature)
3. Look at what happened (order created? refund? cancellation?)
4. Send the right event to Inngest to process
```

**Events it sends:**
- `shopify/order.created` - New order placed
- `shopify/order.paid` - Order payment confirmed
- `shopify/order.cancelled` - Order was cancelled
- `shopify/refund.created` - Customer got a refund

---

#### `/src/app/api/webhooks/gps/route.ts`
**What it does:** Receives notifications from GPS warehouse when they ship an order.

**In simple terms:** When GPS warehouse packs and ships your order, they call this URL and say "We shipped order #123 with tracking number XYZ!"

**Key logic:**
```
1. Receive webhook from GPS
2. Verify signature
3. Send "gps/fulfilment.received" event to Inngest
```

---

#### `/src/app/api/webhooks/stord/route.ts`
**What it does:** Same as GPS, but for STORD warehouse (US Atlanta location).

---

#### `/src/app/api/inngest/route.ts`
**What it does:** This is Inngest's "control center" - it receives events and triggers the right functions.

**In simple terms:** This is the brain that decides "Oh, an order was created? Let me run the order processing function."

---

### 2. INNGEST FUNCTIONS (The Workers)

These are the "workers" that actually do the processing. Each function handles one type of event.

#### `/src/inngest/functions/process-shopify-order.ts`
**What it does:** The main order processing workflow. Takes a Shopify order and:
1. Creates it in D365 (accounting system)
2. Sends it to GPS warehouse for shipping

**The magic - STEPS:**
```typescript
// Step 1: Check if order already exists (don't process twice!)
const existingOrder = await step.run("check-existing-d365-order", async () => {
  return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
});

// Step 2: Create the order header in D365
const d365Header = await step.run("create-d365-header", async () => {
  return dynamics.createSalesOrderHeaderV3(headerRequest);
});

// Step 3: Create order lines (the products)
await step.run("create-d365-lines", async () => {
  // Add each product to the order
});

// Step 4: Confirm the order
await step.run("confirm-d365-order", async () => {
  await dynamics.confirmSalesOrder(salesOrderNumber);
});

// Step 5: Create prepayment (mark as paid)
await step.run("create-d365-prepayment", async () => {
  await dynamics.createPrepayment(salesOrderNumber);
});

// Step 6: Send to warehouse
await step.run("send-to-gps-warehouse", async () => {
  return gps.createOutboundOrder(gpsOrder);
});
```

**Why steps matter:**
- Each step is a **checkpoint**
- If step 4 fails, it doesn't redo steps 1-3
- If the server crashes, it resumes from the last completed step
- This is **durable execution** - the killer feature!

**Self-healing (Out of Stock):**
```typescript
if (error instanceof OutOfStockError) {
  // Wait 4 hours and try again automatically!
  await step.sleep("wait-for-stock", "4h");
  await step.run("retry-gps-after-oos", async () => {
    return gps.createOutboundOrder(gpsOrder);
  });
}
```

---

#### `/src/inngest/functions/process-gps-fulfilment.ts`
**What it does:** When GPS ships an order, this function:
1. Gets the Shopify order details
2. Creates a fulfillment in Shopify (adds tracking number)
3. Creates a packing slip in D365

**In simple terms:** GPS says "I shipped it!" → Battle Bus tells Shopify "Add this tracking number" → Battle Bus tells D365 "Mark this as shipped"

---

#### `/src/inngest/functions/process-stord-fulfilment.ts`
**What it does:** Same as GPS fulfilment, but for STORD warehouse.

---

#### `/src/inngest/functions/process-refund.ts`
**What it does:** When a refund happens in Shopify:
1. Finds the original D365 order
2. Creates a credit note in D365

**In simple terms:** Customer gets refund → Battle Bus tells D365 "Give them their money back"

---

#### `/src/inngest/functions/process-order-cancellation.ts`
**What it does:** When an order is cancelled:
1. Tries to cancel in GPS (if not shipped yet)
2. Marks as cancelled in D365

---

### 3. API CLIENTS (Talking to External Systems)

These are the "translators" that know how to talk to each external system.

#### `/src/lib/clients/dynamics.ts`
**What it does:** Talks to Microsoft Dynamics 365 (D365) - the accounting/ERP system.

**Key functions:**
- `authenticate()` - Get access token from Azure AD
- `createSalesOrderHeaderV3()` - Create a new order
- `createSalesOrderLine()` - Add products to an order
- `confirmSalesOrder()` - Confirm the order is ready
- `createPrepayment()` - Mark order as paid
- `createFulfilment()` - Create packing slip when shipped
- `getSalesOrderByShopifyId()` - Look up existing orders

**THK API:** D365 uses custom "THK" endpoints (not standard OData). These are Prenetics-specific APIs:
- `/api/services/THK_APISyncServiceGroup/.../confirmSO` - Confirm order
- `/api/services/THK_APISyncServiceGroup/.../PostPrepayment` - Record payment
- `/api/services/THK_APISyncServiceGroup/.../fulfilment` - Record shipment

---

#### `/src/lib/clients/gps.ts`
**What it does:** Talks to GPS warehouse system.

**Key functions:**
- `generateAuthCode()` - Create authentication signature (HMAC)
- `createOutboundOrder()` - Send order to warehouse for shipping
- `getOutboundOrdersDetails()` - Check order status
- `cancelOutboundOrder()` - Cancel an order

**Auth Code Algorithm (CRITICAL):**
GPS uses a special signature algorithm:
1. Take the request data
2. Sort ALL keys alphabetically (including nested objects!)
3. Concatenate all values
4. Create HMAC-SHA256 hash

```typescript
function deepSortKeys(obj) {
  // Recursively sort all keys
}
const authCode = sha256Hmac(sortedConcatenatedString, apiSecret);
```

---

#### `/src/lib/clients/shopify.ts`
**What it does:** Talks to Shopify's API.

**Key functions:**
- `getOrder()` - Get order details
- `getFulfillmentOrders()` - Get fulfillment info
- `createFulfillment()` - Add tracking number to order
- `verifyWebhookSignature()` - Verify webhooks are really from Shopify

---

### 4. TRANSFORMERS (Data Conversion)

These convert data from one format to another.

#### `/src/lib/transformers/order.ts`
**What it does:** Converts Shopify order format to D365/GPS formats.

**Key functions:**
- `toD365SalesOrderHeaderV3()` - Shopify order → D365 header
- `toD365SalesOrderLines()` - Shopify line items → D365 lines
- `toGpsOutboundOrder()` - Shopify order → GPS order format

**Example transformation:**
```
Shopify Order:
{
  "name": "#IM8-1234",
  "total_price": "99.99",
  "line_items": [{ "sku": "IM8-FG-000010", "quantity": 1 }]
}

↓ Transform ↓

D365 Order:
{
  "THK_ShopifyReference": "#IM8-1234",
  "CurrencyCode": "USD",
  "OrderingCustomerAccountNumber": "U001-C000000001"
}
```

---

#### `/src/lib/transformers/address.ts`
**What it does:** Converts Shopify addresses to D365/GPS formats.

**Special handling:**
- UAE/Saudi Arabia don't have postal codes → uses "00000"
- D365 needs ISO3 country codes (USA) not ISO2 (US)

---

#### `/src/lib/transformers/sku.ts`
**What it does:** Maps product SKUs between systems.

**Why needed:**
- Some Shopify SKUs need to become different D365 SKUs
- "Refill" products map to different SKUs
- "Reward" products have special mappings

**Key functions:**
- `mapShopifySkuToDynamics()` - Convert SKU
- `mergeGpsDuplicateSkuLines()` - GPS doesn't like duplicate SKUs, so combine them
- `filterServiceSkus()` - Remove shipping/tax SKUs before sending to warehouse

---

### 5. HELPERS (Utility Functions)

#### `/src/lib/helpers/warehouse.ts`
**What it does:** Determines which warehouse to use and gets warehouse-specific config.

**Key functions:**
- `determineWarehouse()` - Based on shipping country, pick the right warehouse:
  - US orders → GPS Warehouse (New York)
  - UK/EU orders → GPS UK Warehouse
  - Asia orders → HK Warehouse
  
- `getWarehouseConfig()` - Get warehouse-specific settings
- `getShippingSku()` / `getTaxSku()` - Get service SKUs for each warehouse

---

#### `/src/lib/helpers/country.ts`
**What it does:** Converts country codes.

**Why needed:** D365 uses ISO3 codes (USA, GBR) but Shopify uses ISO2 (US, GB).

---

### 6. CONFIGURATION

#### `/src/lib/config.ts`
**What it does:** Central place for all settings.

**Key sections:**
- `dynamics` - D365 connection settings
- `gps` - GPS warehouse settings
- `shopify` - Shopify API settings
- `features` - Feature flags (enable/disable integrations)
- `delays` - Timing settings (retry delays, etc.)

**Feature flags:**
```typescript
features: {
  enableDynamicsSync: true,   // Send to D365?
  enableGpsSync: true,        // Send to GPS?
  dryRunMode: false,          // Just log, don't actually do anything?
}
```

---

### 7. DATA FILES

#### `/src/lib/mappings/warehouse-config.json`
**What it does:** Defines all warehouse configurations.

**Contains for each warehouse:**
- Country code
- D365 data area ID
- GPS warehouse code
- Fulfilment site/warehouse IDs
- Service SKUs (tax, shipping, refund)

---

#### `/src/lib/mappings/dynamics-sku.json`
**What it does:** SKU mapping rules.

**Contains:**
- `refill` - Maps original SKU → refill SKU
- `reward` - Maps reward tier → reward SKU
- `merge` - Maps Shopify SKU → D365 SKU

---

### 8. EVENT DEFINITIONS

#### `/src/inngest/events.ts`
**What it does:** Defines the "shape" of each event type.

**Events:**
- `shopify/order.created` - Contains order JSON
- `shopify/refund.created` - Contains refund JSON
- `shopify/order.cancelled` - Contains cancellation info
- `gps/fulfilment.received` - Contains tracking info
- `stord/fulfilment.received` - Contains tracking info

---

## How It All Flows Together

### Order Flow (Happy Path)

```
1. Customer orders on Shopify
   ↓
2. Shopify calls /api/webhooks/shopify
   ↓
3. Webhook handler sends "shopify/order.created" event
   ↓
4. Inngest triggers processShopifyOrder function
   ↓
5. Step 1: Check D365 for existing order (idempotency)
   ↓
6. Step 2: Create D365 header (toD365SalesOrderHeaderV3)
   ↓
7. Step 3: Create D365 lines (toD365SalesOrderLines)
   ↓
8. Step 4: Confirm D365 order (confirmSalesOrder)
   ↓
9. Step 5: Create prepayment (createPrepayment)
   ↓
10. Step 6: Send to GPS (toGpsOutboundOrder → createOutboundOrder)
    ↓
11. GPS ships the order
    ↓
12. GPS calls /api/webhooks/gps
    ↓
13. Webhook handler sends "gps/fulfilment.received" event
    ↓
14. Inngest triggers processGpsFulfilment function
    ↓
15. Step 1: Get Shopify order details
    ↓
16. Step 2: Create Shopify fulfillment (add tracking)
    ↓
17. Step 3: Create D365 packing slip
    ↓
18. DONE! Customer gets tracking email
```

### Error Recovery Flow

```
1. Step 4 (confirm order) fails due to network error
   ↓
2. Inngest automatically retries (up to 5 times)
   ↓
3. If still failing, function is marked "failed"
   ↓
4. You can click "Rerun" in Inngest UI
   ↓
5. Function resumes from Step 4 (not Step 1!)
```

### Out of Stock Flow

```
1. GPS returns "out of stock" error
   ↓
2. Function catches OutOfStockError
   ↓
3. step.sleep("wait-for-stock", "4h") - pause for 4 hours
   ↓
4. After 4 hours, Inngest wakes up the function
   ↓
5. Retry sending to GPS
   ↓
6. If still OOS, the error propagates and Inngest retries
```

---

## Key Concepts

### Idempotency
**What:** Processing the same order twice should have the same result as processing it once.

**How:** 
- Check if order exists in D365 before creating
- Inngest has built-in idempotency key: `event.data.shopifyOrderId`

### Durable Execution
**What:** If a function crashes mid-way, it can resume from where it left off.

**How:** Each `step.run()` is a checkpoint. Inngest stores the result.

### Feature Flags
**What:** Turn features on/off without code changes.

**How:** Environment variables control behavior:
- `DRY_RUN_MODE=true` - Log but don't actually call APIs
- `ENABLE_DYNAMICS_SYNC=false` - Skip D365 integration

---

## Why This Is Better Than Spock-Store

| Aspect | Spock-Store | Battle Bus |
|--------|-------------|------------|
| Processing | Poll database every X seconds | React to events instantly |
| Visibility | Check logs/database | See every step in Inngest UI |
| Failures | Silent or email | See exact step that failed |
| Recovery | Manual reprocess | Click "Rerun" or auto-retry |
| OOS | Manual intervention | Auto-retry after 4 hours |
| Debugging | Dig through logs | Click run, see full payload |
| Scaling | Single server | Serverless, auto-scales |
