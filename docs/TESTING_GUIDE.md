# Testing Guide

For full test cases across all flows (goals, preconditions, constraints, expected behavior, results tracking):

- `docs/FLOW_TEST_CASES.md`

## Prerequisites

1. **Install dependencies:**

   ```bash
   cd inngest
   npm install
   ```

2. **Environment variables** (in `.env.local`):
   - `SUPABASE_URL` - Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
   - `SHOPIFY_IM8_WEBHOOK_SECRET` - Shopify webhook secret
   - `BATTLE_BUS_URL` - Battle Bus URL (default: http://localhost:7000)

3. **Start services:**

   ```bash
   # Terminal 1: Battle Bus server
   npm run dev

   # Terminal 2: Inngest dev server
   npm run dev:inngest
   ```

## Testing Order Incoming

### Test Script

```bash
./scripts/test-order-incoming.sh
```

### What it tests:

1. Sends a Shopify `orders/create` webhook to Battle Bus
2. Verifies webhook is accepted (200/201 response)
3. Order should be processed by Inngest:
   - Validated
   - Routed to correct DataAreaId based on location
   - Created in D365 (if enabled)
   - Created in GPS (if applicable)

### Manual Verification:

1. Check Inngest dashboard: `http://localhost:8288`
2. Look for `process-shopify-order` function execution
3. Verify order in D365 (if Dynamics sync enabled)
4. Verify GPS order creation (if GPS sync enabled)

## Testing Inventory Sync

### Test Script

```bash
./scripts/test-inventory-sync.sh
```

### What it tests:

1. API health check
2. Shopify → Dynamics inventory sync
3. Shopify → Dynamics + GPS multi-destination sync

### Manual Verification:

1. Check Inngest dashboard for `process-inventory-mesh` function
2. Verify inventory in Dynamics (if enabled)
3. Verify inventory in GPS (if enabled)
4. Check Battle Hub for inventory updates

## Testing Product Sync

### Test GPS Product Sync

```bash
npm run test:gps-product
```

### Test D365 Product Sync

```bash
npm run test:d365-product
```

### Test Product to Hub

```bash
npm run test:product-hub
```

## Location Routing Testing

The location routing service now fetches directly from Supabase:

1. **Verify Supabase connection:**
   - Check `.env.local` has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - Location routing will fallback to config if Supabase unavailable

2. **Test location mapping:**
   - Location routing caches mappings for 5 minutes
   - Force refresh: Call `getLocationMappings(true)`

3. **Verify routing:**
   - Orders with fulfillment locations should route to correct DataAreaId
   - Check logs for: `[Order Routing] Using location-based routing: ...`

## Common Issues

### GPS Variant Error

**Fixed:** Added validation for variants array and filtering of invalid variants.

**Symptoms:**

- Error: "Cannot read property 'sku' of undefined"
- GPS product sync fails

**Solution:**

- Variants are now validated before processing
- Invalid variants are filtered out
- Empty variant arrays return early with error message

### Location Routing Not Working

**Symptoms:**

- Orders not routing to correct DataAreaId
- Using fallback mappings

**Solution:**

1. Verify Supabase credentials in `.env.local`
2. Check `locations` table has data with `dynamics_data_area_id`
3. Verify location cache is refreshed (5 min TTL)
4. Check logs for Supabase connection errors

### Inventory Sync Not Working

**Symptoms:**

- Inventory not syncing to Dynamics/GPS
- Mesh API returns errors

**Solution:**

1. Verify Inngest is running
2. Check `process-inventory-mesh` function in Inngest dashboard
3. Verify location routing is working (for DataAreaId resolution)
4. Check destination platform configurations

## Debugging Tips

1. **Check Inngest Dashboard:**
   - View function executions
   - Check step-by-step logs
   - View retry attempts

2. **Check Logs:**
   - Battle Bus server logs
   - Inngest function logs
   - Look for `[LocationRouting]`, `[Order Routing]`, `[InventoryMesh]` prefixes

3. **Test API Directly:**

   ```bash
   # Test location mappings
   curl http://localhost:7000/api/inventory/sync

   # Test order webhook
   ./scripts/test-order-incoming.sh
   ```

4. **Clear Cache:**
   - Location routing cache: 5 minutes TTL (auto-refreshes)
   - Force refresh by restarting server or calling `getLocationMappings(true)`
