# D365 Flows Testing Guide

## Quick Start

```bash
# Run all tests (uses default ngrok URL)
cd /Users/prenetics/work/Development/battle-bus/battle-bus-inngest
./scripts/test-all-d365-flows.sh

# Or specify your ngrok URL
./scripts/test-all-d365-flows.sh https://your-ngrok-url.ngrok-free.app
```

## What Gets Tested

The script tests **6 D365 flows** in sequence:

1. ✅ **Flow 1: Create New Order** → Creates D365 order (header + lines + confirm + prepayment)
2. ✅ **Flow 2: STORD/HK Fulfillment** → Creates D365 packing slip from Shopify fulfillment
3. ⚠️ **Flow 3: GPS Fulfillment** → Info only (cron-based, must trigger manually)
4. ✅ **Flow 4: Extensiv Fulfillment** → Creates D365 packing slip from Extensiv webhook
5. ✅ **Flow 5: Order Cancellation** → Creates D365 return order if GPS cancel fails
6. ✅ **Flow 7: Refund** → Creates D365 return order

## Prerequisites

1. **PM2 running** with `battle-bus-inngest` process
2. **ngrok tunnel** active (check with `pm2 logs ngrok-app`)
3. **TESTING_MODE** can be `true` or `false` (script works with both)
4. **D365 credentials** configured in `.env.local` or config

## Manual Testing (Individual Flows)

### Flow 1: Create New Order

```bash
ORDER_ID=$(date +%s)$RANDOM
ORDER_NAME="#TEST-ORDER-$ORDER_ID"

curl -k -X POST https://your-ngrok-url.ngrok-free.app/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": $ORDER_ID,
    \"name\": \"$ORDER_NAME\",
    \"email\": \"test@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
    \"line_items\": [{
      \"id\": 1,
      \"sku\": \"IM8-FG-000053\",
      \"title\": \"Daily Ultimate Essentials\",
      \"quantity\": 1,
      \"price\": \"89.00\",
      \"requires_shipping\": true
    }],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"User\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    }
  }"

# Check logs
tail -50 logs/pm2-out.log | grep -E "$ORDER_NAME|D365|Created sales order"
```

### Flow 2: STORD/HK Fulfillment

```bash
# First create order (use Flow 1), then:
curl -k -X POST https://your-ngrok-url.ngrok-free.app/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/fulfilled" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": $ORDER_ID,
    \"name\": \"$ORDER_NAME\",
    \"fulfillments\": [{
      \"id\": 1001,
      \"status\": \"success\",
      \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
      \"tracking_number\": \"TEST-TRACK-123\",
      \"tracking_company\": \"FedEx\",
      \"location_id\": \"99999999999\",
      \"line_items\": [{
        \"id\": 1,
        \"sku\": \"IM8-FG-000053\",
        \"quantity\": 1
      }]
    }]
  }"
```

### Flow 3: GPS Fulfillment (Cron)

**Manual Trigger:**
1. Open Inngest Dev UI: http://localhost:8288
2. Find function: `Sync GPS Fulfillments` (cron-gps-sync)
3. Click "Trigger" button
4. Check logs: `tail -100 logs/pm2-out.log | grep "GPS Sync"`

### Flow 4: Extensiv Fulfillment

```bash
curl -k -X POST https://your-ngrok-url.ngrok-free.app/api/webhooks/extensiv \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"OrderConfirm\",
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"data\": {
      \"orderNumber\": \"#TEST-EXTENSIV-123\",
      \"trackingNumber\": \"EXT-TRACK-123\",
      \"carrier\": \"FedEx\",
      \"items\": [{
        \"sku\": \"IM8-FG-000053\",
        \"quantity\": 1
      }]
    }
  }"
```

### Flow 5: Order Cancellation

```bash
# First create order (use Flow 1), then:
curl -k -X POST https://your-ngrok-url.ngrok-free.app/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/cancelled" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": $ORDER_ID,
    \"name\": \"$ORDER_NAME\",
    \"cancel_reason\": \"customer\",
    \"cancelled_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"line_items\": [{
      \"id\": 1,
      \"sku\": \"IM8-FG-000053\",
      \"quantity\": 1
    }]
  }"
```

### Flow 7: Refund

```bash
# First create order (use Flow 1), then:
curl -k -X POST https://your-ngrok-url.ngrok-free.app/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: refunds/create" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"order_id\": $ORDER_ID,
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"note\": \"Test refund\",
    \"refund_line_items\": [{
      \"id\": 1,
      \"line_item_id\": 1,
      \"quantity\": 1,
      \"subtotal\": \"89.00\"
    }]
  }"
```

## Checking Results

### View All D365 Logs

```bash
tail -200 logs/pm2-out.log | grep -E "D365|Created|Confirmed|Return" | tail -30
```

### View Specific Order

```bash
ORDER_NAME="#TEST-ORDER-1234567890"
tail -100 logs/pm2-out.log | grep "$ORDER_NAME"
```

### View Inngest Function Runs

1. Open: http://localhost:8288
2. Click on function name
3. View step-by-step execution

### Check D365 Authentication

```bash
tail -100 logs/pm2-out.log | grep -E "Authentication|scope|token"
```

## Expected Log Messages

### Flow 1 (Create Order)
- `[D365] Looking up order by Shopify ID: ...`
- `[D365] Creating sales order header: ...`
- `[D365] Created sales order: <SalesOrderNumber>`
- `[D365] Created sales order line with lot ID: ...`
- `[D365] Confirmed sales order: <SalesOrderNumber>`
- `[D365] Created prepayment for: <SalesOrderNumber>`

### Flow 2/3/4 (Fulfillment)
- `[D365] Creating fulfilment for: <SalesOrderNumber>`
- `[D365] Created fulfilment for: <SalesOrderNumber>`

### Flow 5/7 (Return Order)
- `[D365] Creating return sales order header: ...`
- `[D365] Created return sales order: <ReturnOrderNumber>`
- `[D365] Created return sales order line with lot ID: ...`
- `[D365] Confirmed sales order: <ReturnOrderNumber>`

## Troubleshooting

### Authentication Errors
- Check `D365_SCOPE` in config (should be `https://p-uat.sandbox.operations.dynamics.com/.default`)
- Check `D365_BASE_URL` is set
- Verify credentials in `.env.local`

### Order Not Found
- Wait 10-15 seconds after creating order before testing fulfillment/cancellation
- Check if order was actually created: `grep "Created sales order" logs/pm2-out.log`

### GPS Sync Not Running
- Check `ENABLE_GPS_SYNC=true` in config
- Manually trigger in Inngest Dev UI
- Check cron schedule: `*/60 * * * *` (every 60 minutes)

### Extensiv Webhook Failing
- Check `DISABLE_EXTENSIV_WEBHOOK_VERIFICATION=true` for testing
- Or set `TESTING_MODE=true` (auto-disables verification)

## Next Steps

After testing all flows:
1. Verify D365 orders exist in D365 system
2. Check Inngest dashboard for any failed steps
3. Review logs for any errors
4. Test with real Shopify orders (if available)

