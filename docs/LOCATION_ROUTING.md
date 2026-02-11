# Location Routing & Warehouse Mapping

## Overview

The Location Routing system provides a centralized way to map Shopify locations to Dynamics 365 DataAreaIds for order and inventory routing. This is critical because:

1. **One-way sync**: Inventory sync is one-way (Locations → Dynamics) because Dynamics uses a common DataAreaId for multiple Shopify locations
2. **Order routing**: Orders need to be routed to the correct Dynamics DataAreaId based on their fulfillment location
3. **Location mapping**: Multiple Shopify locations can map to the same DataAreaId (e.g., GPS Warehouse, Charlotte Warehouse, STORD ATL all use U001)

## Architecture

### Data Flow

```
Shopify Locations (Supabase in Battle Hub)
    ↓
Battle Hub API: /api/locations/mappings
    ↓
Battle Bus Location Routing Service (cached)
    ↓
Order Processing / Inventory Sync
    ↓
Dynamics 365 (with correct DataAreaId)
```

### Storage Strategy

**Recommended Approach: Supabase as Source of Truth**

1. **Battle Hub (Supabase)**: Stores location mappings with DataAreaId
   - `locations` table contains: `id`, `name`, `shopify_location_id`, `warehouse_name`, `dynamics_data_area_id`
   - This is the authoritative source

2. **Battle Bus (Inngest)**: Fetches and caches location mappings
   - Calls Battle Hub API: `/api/locations/mappings`
   - Caches in memory with 5-minute TTL
   - Falls back to config-based mappings if API unavailable

**Why this approach?**
- ✅ Single source of truth (Supabase)
- ✅ Can be updated via Battle Hub UI
- ✅ Battle Bus doesn't need direct database access
- ✅ Caching reduces API calls
- ✅ Fallback ensures reliability

## Location Routing Service

### File: `inngest/src/lib/services/location-routing.ts`

**Key Functions:**

```typescript
// Get DataAreaId for a Shopify location ID (primary routing function)
getDataAreaIdForLocation(shopifyLocationId: string | number, store: string = "im8"): Promise<string | null>

// Get warehouse name for a Shopify location ID
getWarehouseNameForLocation(shopifyLocationId: string | number, store: string = "im8"): Promise<string | null>

// Get all locations for a specific DataAreaId (useful for inventory sync)
getLocationsForDataAreaId(dataAreaId: string, store: string = "im8"): Promise<LocationMapping[]>

// Get all location mappings (with caching)
getLocationMappings(forceRefresh = false): Promise<LocationMapping[]>
```

### Usage in Order Processing

```typescript
// In process-shopify-order.ts
// 1. Get fulfillment location from order
const fulfillmentOrders = await shopify.getFulfillmentOrders(orderId);
const locationId = fulfillmentOrders[0]?.assigned_location_id;

// 2. Route to correct DataAreaId
if (locationId) {
  const dataAreaId = await getDataAreaIdForLocation(locationId, "im8");
  // Use dataAreaId for D365 order creation
}
```

### Usage in Inventory Sync

```typescript
// In process-inventory-mesh.ts
// One-way sync: Location → Dynamics
if (inventory.locationId) {
  const dataAreaId = await getDataAreaIdForLocation(inventory.locationId, "im8");
  // Sync inventory to Dynamics with this dataAreaId
}
```

## Battle Hub API

### Endpoint: `/api/locations/mappings`

**Method:** GET

**Response:**
```json
{
  "success": true,
  "locations": [
    {
      "id": "location-id",
      "name": "GPS Warehouse",
      "shopifyLocationId": "79527313640",
      "warehouseName": "GPS Warehouse",
      "dynamicsDataAreaId": "U001",
      "store": "im8",
      "active": true
    }
  ],
  "count": 5
}
```

## Mapping Examples

### DataAreaId U001 (US)
- GPS Warehouse (Shopify Location ID: 79527313640)
- Charlotte Warehouse
- STORD ATL Location

### DataAreaId H007 (UK/HK)
- GPS UK Warehouse (Shopify Location ID: 82997936360)
- HK Warehouse

### DataAreaId H001 (CircleDNA)
- Primary Circle Warehouse
- TH Circle Warehouse
- HK Circle Warehouse
- JP Circle Warehouse
- Others Circle Warehouse

## Sync Direction

### ✅ One-Way: Locations → Dynamics
- **Why**: Dynamics uses common DataAreaId for multiple locations
- **How**: Use `getDataAreaIdForLocation()` to route inventory from specific location to correct DataAreaId
- **Use case**: Inventory sync from Shopify locations to Dynamics

### ❌ Not Supported: Dynamics → Locations
- **Why**: Dynamics doesn't know which specific Shopify location to update
- **Reason**: Multiple locations share the same DataAreaId
- **Alternative**: Sync from location-specific sources (Shopify, GPS) instead

### ✅ One-Way: Locations → Shopify
- **Why**: Can sync inventory from specific location to Shopify
- **How**: Use location ID to update specific Shopify location inventory
- **Use case**: Inventory sync from GPS/Dynamics to specific Shopify location

## Cache Management

- **TTL**: 5 minutes (configurable)
- **Refresh**: Call `getLocationMappings(true)` to force refresh
- **Clear**: Call `clearLocationCache()` to clear cache
- **Fallback**: Uses config-based mappings if API unavailable

## Future Enhancements

1. **Store-specific routing**: Support multiple stores (im8, circledna)
2. **Location groups**: Group locations by warehouse type
3. **Routing rules**: Custom routing rules based on order attributes
4. **Real-time updates**: Webhook from Battle Hub to invalidate cache

