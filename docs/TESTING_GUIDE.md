# Battle Bus Testing Guide

## Quick Start

### Prerequisites
- Node.js 18+
- npm
- Cloudflare Tunnel (for Shopify webhooks): `npm install -g cloudflared`

### 1. Install Dependencies
```bash
cd im8-battle-bus
npm install
```

### 2. Create Environment File
```bash
cp .env.example .env.local
# Or create manually:
```

```bash
# .env.local
DRY_RUN_MODE=true
ENABLE_DYNAMICS_SYNC=true
ENABLE_GPS_SYNC=true

# Shopify (get from Shopify admin)
SHOPIFY_IM8_ACCESS_TOKEN=your_token
SHOPIFY_IM8_WEBHOOK_SECRET=your_secret
SHOPIFY_IM8_SHOP_DOMAIN=your-store.myshopify.com

# D365 (get from Azure AD)
D365_BASE_URL=https://your-org.operations.dynamics.com
D365_TENANT_ID=your-tenant-id
D365_CLIENT_ID=your-client-id
D365_CLIENT_SECRET=your-client-secret
D365_SCOPE=https://your-org.operations.dynamics.com/.default

# GPS (get from GPS)
GPS_BASE_URL=https://api.xlwms.com
GPS_API_KEY=your-api-key
GPS_API_SECRET=your-api-secret
```

---

## Phase 1: Local Testing

### Step 1: Start the Development Servers

Open 3 terminal windows:

**Terminal 1 - Next.js:**
```bash
npm run dev
```
Expected: `Ready on http://localhost:3000`

**Terminal 2 - Inngest Dev Server:**
```bash
npx inngest-cli@latest dev
```
Expected: `Inngest Dev Server running on http://localhost:8288`

**Terminal 3 - For running tests**

### Step 2: Verify Inngest Connection

1. Open http://localhost:8288 in your browser
2. You should see the Inngest Dev UI
3. Click "Functions" - you should see:
   - `process-shopify-order`
   - `process-refund`
   - `process-gps-fulfilment`
   - `process-stord-fulfilment`
   - `process-order-cancellation`

### Step 3: Send Test Webhook

**Option A: Use the test script**
```bash
./scripts/test-webhook.sh
```

**Option B: Manual curl**
```bash
curl -X POST http://localhost:3000/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/create" \
  -H "x-shopify-shop-domain: test-store.myshopify.com" \
  -d '{
    "id": 12345,
    "name": "#TEST-001",
    "email": "test@example.com",
    "created_at": "2024-01-01T00:00:00Z",
    "total_price": "99.99",
    "subtotal_price": "89.99",
    "total_tax": "10.00",
    "currency": "USD",
    "financial_status": "paid",
    "fulfillment_status": null,
    "line_items": [{
      "id": 1,
      "sku": "IM8-FG-000010",
      "title": "Test Product",
      "quantity": 1,
      "price": "89.99",
      "requires_shipping": true,
      "gift_card": false,
      "total_discount": "0.00"
    }],
    "shipping_address": {
      "first_name": "Test",
      "last_name": "User",
      "address1": "123 Test St",
      "city": "New York",
      "province": "NY",
      "country": "United States",
      "country_code": "US",
      "zip": "10001"
    },
    "shipping_lines": [{
      "title": "Standard Shipping",
      "price": "0.00",
      "code": "standard"
    }],
    "customer": {
      "id": 1,
      "email": "test@example.com",
      "first_name": "Test",
      "last_name": "User"
    }
  }'
```

### Step 4: Verify in Inngest UI

1. Go to http://localhost:8288
2. Click "Events" tab
3. You should see `shopify/order.created` event
4. Click on it to see the payload
5. Click "Runs" to see function execution
6. All steps should show ✅ (with DRY_RUN logs)

### Expected Output (DRY_RUN_MODE=true)
```
[Battle Bus] Processing order: #TEST-001 (12345)
[Dry Run] Would process order: #TEST-001
```

---

## Phase 2: Shopify Test Store Integration

### Step 1: Create Cloudflare Tunnel

```bash
npx cloudflared tunnel --url http://localhost:3000
```

You'll get a URL like: `https://random-words.trycloudflare.com`

### Step 2: Add Webhook in Shopify

1. Go to your Shopify test store admin
2. Settings → Notifications → Webhooks
3. Create webhook:
   - **Event:** Order payment
   - **URL:** `https://your-tunnel.trycloudflare.com/api/webhooks/shopify`
   - **Format:** JSON

4. Repeat for:
   - Order creation
   - Order cancellation
   - Refund creation

### Step 3: Place Test Order

1. Go to your test store
2. Add a product to cart
3. Complete checkout with test payment
4. Watch the Inngest UI for the event

### Step 4: Verify

- [ ] Event received in Inngest
- [ ] Function executed
- [ ] DRY_RUN logs show correct data
- [ ] No errors

---

## Phase 3: D365 Sandbox Testing

### Step 1: Update Environment

```bash
# .env.local
DRY_RUN_MODE=false           # Enable real writes
ENABLE_DYNAMICS_SYNC=true
ENABLE_GPS_SYNC=false        # Disable GPS for now

D365_BASE_URL=https://sandbox.operations.dynamics.com
D365_TENANT_ID=...
D365_CLIENT_ID=...
D365_CLIENT_SECRET=...
```

### Step 2: Restart Servers

```bash
# Terminal 1
npm run dev

# Terminal 2
npx inngest-cli@latest dev
```

### Step 3: Send Test Order

```bash
./scripts/test-webhook.sh
```

### Step 4: Verify in D365

1. Log into D365 sandbox
2. Go to Sales Orders
3. Search for the order by Shopify reference
4. Verify:
   - [ ] Header created with THK fields
   - [ ] Lines created correctly
   - [ ] Order confirmed
   - [ ] Prepayment created

### Step 5: Test Idempotency

```bash
# Send the same order again
./scripts/test-webhook.sh
```

Expected: Second run should skip (order already exists)

---

## Phase 4: GPS Sandbox Testing

### Step 1: Update Environment

```bash
# .env.local
DRY_RUN_MODE=false
ENABLE_DYNAMICS_SYNC=false   # Disable D365 for isolation
ENABLE_GPS_SYNC=true

GPS_BASE_URL=https://api.xlwms.com
GPS_API_KEY=...
GPS_API_SECRET=...
```

### Step 2: Test GPS Order Submission

```bash
./scripts/test-webhook.sh
```

### Step 3: Verify in GPS

1. Log into GPS portal
2. Search for the order
3. Verify order details match

### Step 4: Test GPS Webhook (Fulfilment)

```bash
curl -X POST http://localhost:3000/api/webhooks/gps \
  -H "Content-Type: application/json" \
  -H "x-gps-signature: test" \
  -H "x-gps-timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -d '{
    "orderId": "GPS-12345",
    "orderNumber": "#TEST-001",
    "trackingNumber": "1Z999999999999999",
    "carrierCode": "UPS",
    "shippedDate": "2024-01-15",
    "items": [
      {"sku": "IM8-FG-000010", "quantity": 1}
    ]
  }'
```

---

## Phase 5: Full Integration Test

### Step 1: Enable All Systems

```bash
# .env.local
DRY_RUN_MODE=false
ENABLE_DYNAMICS_SYNC=true
ENABLE_GPS_SYNC=true
```

### Step 2: End-to-End Test

1. Place order in Shopify test store
2. Verify D365 order created
3. Verify GPS order submitted
4. Simulate GPS fulfilment webhook
5. Verify Shopify fulfillment created
6. Verify D365 packing slip created

### Step 3: Test Error Scenarios

**Out of Stock:**
1. Configure GPS to return OOS error
2. Place order
3. Verify function sleeps
4. Verify retry after sleep

**Network Failure:**
1. Temporarily block D365/GPS
2. Place order
3. Verify Inngest retries
4. Restore network
5. Verify order completes

---

## Troubleshooting

### Webhook Not Received

1. Check tunnel is running
2. Verify webhook URL in Shopify
3. Check Next.js console for errors
4. Try `curl` directly to endpoint

### Inngest Function Not Running

1. Check Inngest Dev Server is running
2. Verify functions registered (http://localhost:8288)
3. Check for TypeScript errors: `npx tsc --noEmit`

### D365 Authentication Failed

1. Verify tenant ID, client ID, secret
2. Check scope format: `https://org.operations.dynamics.com/.default`
3. Test token endpoint directly:
```bash
curl -X POST "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  -d "client_id={client_id}" \
  -d "client_secret={secret}" \
  -d "scope={scope}"
```

### GPS Auth Code Invalid

1. Verify API key and secret
2. Check timestamp is current (within 5 min)
3. Enable debug logging to see generated auth code
4. Compare with spock-store output

---

## Test Data

### Sample Shopify Order
```json
{
  "id": 12345678901234,
  "name": "#IM8-1001",
  "email": "customer@example.com",
  "total_price": "149.99",
  "currency": "USD",
  "line_items": [
    {
      "id": 1,
      "sku": "IM8-FG-000010",
      "quantity": 2,
      "price": "74.99"
    }
  ],
  "shipping_address": {
    "country_code": "US",
    "zip": "10001"
  }
}
```

### Sample GPS Fulfilment
```json
{
  "orderId": "GPS-123456",
  "trackingNumber": "1Z999999999999999",
  "carrierCode": "UPS",
  "shippedDate": "2024-01-15"
}
```

---

## Next Steps After Testing

1. **Shadow Production:** Deploy to Vercel, add as second webhook
2. **Monitor:** Watch Inngest dashboard for 24-48 hours
3. **Canary:** Enable real writes, process first orders
4. **Cutover:** Disable spock-store webhooks
