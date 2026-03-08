# Inventory Sync Mesh System

## Overview

The Inventory Sync Mesh is a centralized routing system that synchronizes inventory and product data between multiple platforms:

- **Shopify** (e-commerce)
- **Dynamics 365** (ERP)
- **GPS Warehouse** (3PL)
- **Other Warehouse Systems** (Stord, Extensiv, etc.)

The mesh acts as the "brain" that:

- Knows where data is coming from (source)
- Knows where it needs to go (destination)
- Transforms data between platform formats
- Routes to the correct warehouse/location based on configuration

## Architecture

```
┌─────────────┐
│   Shopify   │───┐
└─────────────┘   │
                  │
┌─────────────┐   │    ┌──────────────────┐    ┌─────────────┐
│  Dynamics   │───┼───▶│  Inventory Mesh  │───▶│  Dynamics   │
└─────────────┘   │    │     (Brain)      │    └─────────────┘
                  │    └──────────────────┘
┌─────────────┐   │           │
│   GPS/WMS   │───┘           │
└─────────────┘               ▼
                        ┌─────────────┐
                        │   GPS/WMS   │
                        └─────────────┘
```

## API Endpoints

### 1. Inventory Sync Mesh API

**Endpoint**: `POST /api/inventory/sync`

**Base URL**:

- Production: `https://battle-bus.vercel.app`
- Local: `http://localhost:7000`

**Query Parameters**:

- `from` (optional): Source platform. If not provided, inferred from request body or defaults to `shopify`
  - Valid values: `shopify`, `dynamics`, `gps`, `warehouse`, `stord`, `extensiv`
- `to` (optional): Comma-separated destination platforms. If not provided, syncs to all platforms except source
  - Valid values: `shopify`, `dynamics`, `gps`, `warehouse`, `stord`, `extensiv`
  - Example: `?from=shopify&to=dynamics,gps`

**Request Headers**:

```
Content-Type: application/json
```

**Request Body Schema**:

```typescript
{
  // Product/Variant Identification (at least one required)
  sku?: string;                    // Product SKU
  inventoryItemId?: string;        // Shopify inventory item ID
  variantId?: string;              // Product variant ID
  productId?: string;              // Product ID (required for delete action)

  // Inventory Data
  quantity?: number;               // Total quantity
  available?: number;              // Available quantity
  reserved?: number;               // Reserved quantity
  committed?: number;              // Committed quantity

  // Location/Warehouse
  locationId?: string | number;    // Shopify location ID or warehouse location
  warehouseId?: string;            // Warehouse identifier (e.g., "GPS-US")
  warehouseName?: string;           // Warehouse name (e.g., "GPS Warehouse")
  dataAreaId?: string;              // Dynamics 365 data area ID (e.g., "H007")

  // Product Metadata (for product sync)
  productTitle?: string;            // Product title
  variantTitle?: string;            // Variant title
  barcode?: string;                 // Product barcode
  price?: string | number;          // Product price
  weight?: number;                  // Product weight
  weightUnit?: string;              // Weight unit (e.g., "kg", "lb")

  // Action & Routing
  action?: "create" | "update" | "delete" | "adjust";  // Default: "update"
  source?: string;                  // Source platform (can use query param instead)
  destination?: string | string[];   // Destination platform(s) (can use query param instead)
  timestamp?: string;                // ISO 8601 timestamp (auto-generated if not provided)
  reason?: string;                   // Reason for sync (e.g., "Stock adjustment", "Manual update")
}
```

**Success Response** (200 OK):

```json
{
  "success": true,
  "message": "Inventory sync initiated from shopify to dynamics, gps",
  "source": "shopify",
  "destinations": ["dynamics", "gps"],
  "eventId": "inventory-sync-shopify-PROD-123-79527313640-1736284800000"
}
```

**Partial Success Response** (202 Accepted):
When Inngest is not available (e.g., in local dev without dev server):

```json
{
  "success": false,
  "message": "Inventory sync queued from shopify to dynamics (1 event(s) failed - check Inngest dev server)",
  "source": "shopify",
  "destinations": ["dynamics"],
  "eventId": "inventory-sync-shopify-PROD-123-79527313640-1736284800000",
  "warnings": [
    {
      "destination": "dynamics",
      "error": "Inngest API Error: 401 Event key not found"
    }
  ],
  "note": "In development mode, events are queued but may not be processed until Inngest dev server is running. Run: npm run dev:inngest"
}
```

**Error Responses**:

**400 Bad Request** - Missing required fields:

```json
{
  "error": "sku, inventoryItemId, or variantId is required"
}
```

**400 Bad Request** - Missing productId for delete:

```json
{
  "error": "productId or variantId is required for delete action"
}
```

**500 Internal Server Error**:

```json
{
  "error": "Internal server error",
  "message": "Error details here"
}
```

**Examples**:

```bash
# Example 1: Sync from Shopify to Dynamics and GPS
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "PROD-123",
    "inventoryItemId": "123456789",
    "locationId": "79527313640",
    "quantity": 100,
    "available": 95,
    "action": "update",
    "reason": "Stock adjustment"
  }'

# Example 2: Sync from warehouse to Shopify
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync?from=warehouse&to=shopify" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "PROD-123",
    "available": 50,
    "warehouseId": "GPS-US",
    "warehouseName": "GPS Warehouse",
    "action": "update",
    "reason": "Warehouse stock update"
  }'

# Example 3: Sync from Dynamics to all platforms (default behavior)
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync?from=dynamics" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "PROD-456",
    "quantity": 200,
    "dataAreaId": "H007",
    "action": "update"
  }'

# Example 4: Product deletion sync
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "999888777",
    "sku": "PROD-DELETE",
    "action": "delete",
    "reason": "Product discontinued"
  }'

# Example 5: Using body for source/destination (alternative to query params)
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "PROD-789",
    "quantity": 75,
    "locationId": "79527313640",
    "source": "shopify",
    "destination": ["dynamics", "gps"],
    "action": "update"
  }'
```

### 2. Health Check & API Documentation

**Endpoint**: `GET /api/inventory/sync`

**Health Check Response** (200 OK):

```json
{
  "status": "ok",
  "service": "inventory-sync-mesh",
  "version": "1.0.0"
}
```

**Endpoint**: `GET /api/inventory/sync?docs=true`

**Documentation Response** (200 OK):

```json
{
  "name": "Inventory Sync Mesh API",
  "description": "Central mesh/router for inventory synchronization between platforms",
  "supportedPlatforms": ["shopify", "dynamics", "gps", "warehouse", "stord", "extensiv"],
  "usage": {
    "method": "POST",
    "url": "/api/inventory/sync",
    "queryParams": {
      "from": "Source platform (shopify, dynamics, gps, etc.)",
      "to": "Comma-separated destination platforms"
    },
    "body": {
      "sku": "Product SKU",
      "inventoryItemId": "Shopify inventory item ID",
      "variantId": "Product variant ID",
      "quantity": "Inventory quantity",
      "available": "Available quantity",
      "locationId": "Location/warehouse ID",
      "action": "create | update | delete | adjust",
      "source": "Source platform (optional, can use query param)",
      "destination": "Destination platform(s) (optional, can use query param)"
    }
  },
  "examples": [
    {
      "description": "Sync inventory from Shopify to Dynamics and GPS",
      "url": "/api/inventory/sync?from=shopify&to=dynamics,gps",
      "body": {
        "sku": "PROD-123",
        "quantity": 100,
        "locationId": "79527313640",
        "action": "update"
      }
    }
  ]
}
```

## Webhook Integration

### Shopify Webhooks

The system automatically handles Shopify webhooks for product and inventory changes.

**Webhook Endpoint**: `POST /api/webhooks/shopify`

**Base URL**:

- Production: `https://battle-bus.vercel.app/api/webhooks/shopify`
- Local: `http://localhost:7000/api/webhooks/shopify`

**Required Headers** (from Shopify):

```
x-shopify-topic: products/create | products/update | products/delete | inventory_levels/update
x-shopify-shop-domain: im8-store.myshopify.com
x-shopify-hmac-sha256: <HMAC signature>
x-shopify-webhook-id: <webhook-id>
x-shopify-api-version: <api-version>
```

**Webhook Events Handled**:

#### 1. Product Events

**`products/create`** - New product created

- **Event Sent**: `shopify/product.created`
- **Inngest Function**: `process-product-sync`
- **Sync Destinations**: Dynamics 365, GPS Warehouse
- **Payload Example**:

```json
{
  "id": 123456789,
  "title": "Test Product",
  "status": "active",
  "vendor": "Test Vendor",
  "product_type": "Test Type",
  "tags": "test, product",
  "variants": [
    {
      "id": 987654321,
      "sku": "PROD-123",
      "price": "99.99",
      "barcode": "123456789012",
      "weight": 1.5,
      "weight_unit": "kg",
      "inventory_quantity": 100
    }
  ]
}
```

**`products/update`** - Product updated

- **Event Sent**: `shopify/product.updated`
- **Inngest Function**: `process-product-sync`
- **Sync Destinations**: Dynamics 365, GPS Warehouse
- **Payload**: Same structure as `products/create`

**`products/delete`** - Product deleted

- **Event Sent**: `shopify/product.deleted`
- **Inngest Function**: `process-product-sync`
- **Sync Destinations**: Dynamics 365, GPS Warehouse (deletion)
- **Payload Example**:

```json
{
  "id": 123456789,
  "title": "Deleted Product"
}
```

#### 2. Inventory Events

**`inventory_levels/update`** - Inventory level changed

- **Event Sent**: `inventory/sync` (via mesh)
- **Inngest Function**: `process-inventory-mesh`
- **Sync Destinations**: Dynamics 365, GPS Warehouse
- **Payload Example**:

```json
{
  "inventory_item_id": 123456789,
  "location_id": 79527313640,
  "available": 95,
  "updated_at": "2026-02-07T10:00:00Z"
}
```

**Webhook Flow**:

1. Shopify sends webhook to `/api/webhooks/shopify`
2. Webhook handler verifies HMAC signature
3. Handler sends Inngest event based on topic:
   - Product events → `shopify/product.*` events
   - Inventory events → `inventory/sync` events (via mesh)
4. Inngest functions process events and sync to destinations

**Webhook Verification**:

- HMAC SHA256 signature verification (required in production)
- Signature validation can be disabled in development mode
- Invalid signatures return `401 Unauthorized`

**Response Codes**:

- `200 OK`: Webhook received and processed
- `401 Unauthorized`: Invalid HMAC signature
- `400 Bad Request`: Invalid payload
- `500 Internal Server Error`: Processing error

**Example Webhook Test** (local development):

```bash
curl -X POST "http://localhost:7000/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: inventory_levels/update" \
  -H "x-shopify-shop-domain: im8-store.myshopify.com" \
  -H "x-shopify-hmac-sha256: <signature>" \
  -H "x-shopify-webhook-id: test-123" \
  -H "x-shopify-api-version: 2024-01" \
  -d '{
    "inventory_item_id": 123456789,
    "location_id": 79527313640,
    "available": 95,
    "updated_at": "2026-02-07T10:00:00Z"
  }'
```

## Inngest Functions

### 1. `process-inventory-mesh`

Processes `inventory/sync` events and routes inventory changes to destination platforms.

**Event**: `inventory/sync`

**Data Structure**:

```typescript
{
  source: "shopify" | "dynamics" | "gps" | "warehouse",
  destination: "shopify" | "dynamics" | "gps" | "warehouse",
  payload: {
    sku?: string;
    inventoryItemId?: string;
    quantity?: number;
    available?: number;
    locationId?: string | number;
    action?: "create" | "update" | "delete" | "adjust";
    // ... other fields
  }
}
```

### 2. `process-product-sync`

Processes Shopify product create/update/delete events.

**Events**:

- `shopify/product.created`
- `shopify/product.updated`
- `shopify/product.deleted`

## Supported Platforms

### Shopify

- **Inventory Updates**: Uses `inventory_levels/set` API
- **Product Sync**: Full product + variant data
- **Location Mapping**: Maps location IDs to warehouse IDs

### Dynamics 365

- **Inventory Sync**: Uses `syncInventoryLevel()` function
- **Product Sync**: Uses `syncProduct()` function
- **Warehouse Mapping**: Maps to `dataAreaId` (H007, etc.)

### GPS Warehouse

- **Inventory Sync**: Uses `syncInventoryLevel()` function
- **Product Sync**: Uses `syncProduct()` function
- **Warehouse Mapping**: Maps to GPS warehouse names

## Data Flow Examples

### Example 1: Shopify Inventory Update → Dynamics & GPS

1. Shopify webhook fires: `inventory_levels/update`
2. Webhook handler sends `inventory/sync` event to mesh
3. Mesh routes to Dynamics and GPS
4. Each platform syncs the inventory level

### Example 2: Warehouse Inventory Update → Shopify

1. Warehouse system calls `/api/inventory/sync?from=warehouse&to=shopify`
2. Mesh receives request and sends `inventory/sync` event
3. Mesh routes to Shopify
4. Shopify inventory level is updated

### Example 3: Product Deletion from Shopify

1. Shopify webhook fires: `products/delete`
2. Webhook handler sends `shopify/product.deleted` event
3. Product sync function processes deletion
4. Product is deleted from Dynamics and GPS

## Configuration

### Location/Warehouse Mapping

The system maps locations between platforms:

```typescript
// Shopify Location ID → Dynamics dataAreaId
"79527313640" → "H007" // GPS US
"82997936360" → "H007" // GPS UK

// Shopify Location ID → GPS Warehouse Name
"79527313640" → "GPS Warehouse"
"82997936360" → "GPS UK Warehouse"
```

### Platform Configuration

Platform-specific settings are in `config.ts`:

```typescript
shopify: {
  im8: {
    locations: {
      gps: "79527313640",
      gpsUk: "82997936360",
    }
  }
},
dynamics: {
  dataAreaId: "H007",
},
```

## Error Handling

### API Error Handling

**Client Errors (4xx)**:

- **400 Bad Request**: Invalid request body, missing required fields
- **401 Unauthorized**: Invalid webhook signature (for webhooks)
- **404 Not Found**: Invalid endpoint

**Server Errors (5xx)**:

- **500 Internal Server Error**: Unexpected server error
- **502 Bad Gateway**: Upstream service unavailable
- **503 Service Unavailable**: Service temporarily unavailable

**Partial Success (202 Accepted)**:

- When Inngest is not available (local dev without dev server)
- Events are queued but not processed
- Response includes warnings about failed events

### Inngest Function Error Handling

- **Retry Logic**: Uses Inngest's retry configuration (default: 3 retries with exponential backoff)
- **Idempotency**: Event IDs prevent duplicate processing (24-hour window)
- **Logging**: Comprehensive logging for debugging
- **Fallbacks**: Graceful degradation if a platform is unavailable
- **Step-level Retries**: Each sync step (D365, GPS) can retry independently

### Error Response Format

```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "requestId": "unique-request-id" // For webhooks
}
```

### Common Error Scenarios

1. **Inngest Not Available** (Local Dev):
   - Status: 202 Accepted
   - Response includes warnings and note about starting dev server

2. **Missing Required Fields**:
   - Status: 400 Bad Request
   - Error message specifies which fields are missing

3. **Invalid Platform**:
   - Status: 400 Bad Request
   - Error message lists valid platforms

4. **Platform Sync Failure**:
   - Status: 200 OK (event sent successfully)
   - Actual sync failure logged in Inngest function
   - Retry handled by Inngest automatically

## Authentication & Security

### API Authentication

Currently, the Inventory Sync Mesh API does not require authentication for direct API calls. However:

- **Webhook Authentication**: Shopify webhooks require valid HMAC SHA256 signatures
- **Production Recommendations**:
  - Consider adding API key authentication for production use
  - Use HTTPS only in production
  - Implement rate limiting per IP/client

### Webhook Security

**Shopify Webhook Verification**:

- HMAC SHA256 signature verification
- Signature calculated from request body + webhook secret
- Invalid signatures return `401 Unauthorized`
- Can be disabled in development mode (`NODE_ENV !== "production"`)

**Webhook Secret**:

- Stored in environment variable: `SHOPIFY_WEBHOOK_SECRET`
- Must match Shopify webhook configuration
- Never expose in client-side code or logs

## Rate Limiting

Currently, there are no explicit rate limits on the API. However:

- **Inngest Concurrency**: Functions are limited to 20 concurrent executions
- **Debouncing**: Inventory updates are debounced (10 seconds) to prevent rapid-fire updates
- **Future**: Consider implementing rate limiting per client/IP

## Best Practices

### 1. Event Idempotency

- Always include unique identifiers (`sku`, `inventoryItemId`, etc.)
- Event IDs are auto-generated but can be customized
- Duplicate events within 24 hours are automatically deduplicated by Inngest

### 2. Error Handling

- Always check the `success` field in responses
- Handle `warnings` array for partial failures
- In development, check `note` field for Inngest dev server status
- Implement retry logic for transient failures

### 3. Data Validation

- Validate required fields before sending requests
- Use appropriate data types (numbers for quantities, strings for IDs)
- Include `timestamp` for audit trails
- Provide `reason` for better tracking

### 4. Testing

- Test in development mode first
- Use test SKUs and product IDs
- Verify Inngest dev server is running for full event processing
- Check Inngest dashboard (http://localhost:8288) for event status

### 5. Monitoring

- Monitor Inngest function runs for sync status
- Check logs for errors and warnings
- Track sync latency and success rates
- Set up alerts for sync failures

## Troubleshooting

### Common Issues

**1. "Inngest API Error: 401 Event key not found"**

- **Cause**: Inngest dev server not running
- **Solution**: Run `npm run dev:inngest` or `npm run dev:all`
- **Workaround**: API still returns 202 with warnings (events queued)

**2. "sku, inventoryItemId, or variantId is required"**

- **Cause**: Missing product identification in request
- **Solution**: Include at least one identifier field

**3. "productId or variantId is required for delete action"**

- **Cause**: Delete action requires product/variant ID
- **Solution**: Include `productId` or `variantId` in request

**4. Events not processing**

- **Check**: Inngest dev server running (http://localhost:8288)
- **Check**: Function registered in `src/inngest/functions/index.ts`
- **Check**: Event name matches function trigger

**5. Sync not reaching destination**

- **Check**: Destination platform configuration in `config.ts`
- **Check**: Platform-specific sync functions implemented
- **Check**: Inngest function logs for errors

## Future Enhancements

- [ ] Bidirectional sync (prevent sync loops)
- [ ] Conflict resolution (when same item updated in multiple platforms)
- [ ] Batch sync operations
- [ ] Real-time sync status tracking
- [ ] Warehouse-specific transformations
- [ ] SKU mapping between platforms
- [ ] Inventory reservation sync
- [ ] API key authentication
- [ ] Rate limiting per client
- [ ] Webhook retry logic
- [ ] Sync performance metrics dashboard
- [ ] Webhook replay functionality

## Testing

### Local Testing

**Prerequisites**:

1. Start Next.js dev server: `npm run dev` (runs on port 7000)
2. (Optional) Start Inngest dev server: `npm run dev:inngest` (for event processing)
3. Or run both: `npm run dev:all`

**Test Scripts**:

```bash
# Run comprehensive test suite
./scripts/test-inventory-mesh.sh

# Run simple test suite
./scripts/test-inventory-mesh-simple.sh

# Test with custom URL
./scripts/test-inventory-mesh.sh http://localhost:7000
```

**Manual Testing**:

```bash
# 1. Health check
curl http://localhost:7000/api/inventory/sync

# 2. Get API documentation
curl "http://localhost:7000/api/inventory/sync?docs=true"

# 3. Test inventory sync (Shopify → Dynamics)
curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "TEST-123",
    "inventoryItemId": "123456789",
    "locationId": "79527313640",
    "quantity": 50,
    "available": 48,
    "action": "update",
    "reason": "Test sync"
  }'

# 4. Test multi-destination sync
curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "TEST-456",
    "quantity": 100,
    "locationId": "79527313640",
    "action": "update"
  }'

# 5. Test product deletion
curl -X POST "http://localhost:7000/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "999888777",
    "sku": "TEST-DELETE",
    "action": "delete"
  }'

# 6. Test warehouse → Shopify sync
curl -X POST "http://localhost:7000/api/inventory/sync?from=warehouse&to=shopify" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "TEST-789",
    "available": 75,
    "warehouseId": "GPS-US",
    "action": "update"
  }'
```

### Production Testing

```bash
# Test against production
curl -X POST "https://battle-bus.vercel.app/api/inventory/sync?from=shopify&to=dynamics" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "PROD-123",
    "quantity": 100,
    "locationId": "79527313640",
    "action": "update"
  }'
```

### Testing Webhooks

**Simulate Shopify Inventory Webhook**:

```bash
curl -X POST "http://localhost:7000/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: inventory_levels/update" \
  -H "x-shopify-shop-domain: im8-store.myshopify.com" \
  -H "x-shopify-webhook-id: test-123" \
  -H "x-shopify-api-version: 2024-01" \
  -d '{
    "inventory_item_id": 123456789,
    "location_id": 79527313640,
    "available": 95,
    "updated_at": "2026-02-07T10:00:00Z"
  }'
```

**View Inngest Events** (when dev server is running):

- Open http://localhost:8288 to see event processing in Inngest dashboard
- View function runs, retries, and errors
- Debug event payloads and function execution
