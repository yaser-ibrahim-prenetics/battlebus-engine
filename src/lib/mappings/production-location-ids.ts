// ============================================================================
// PRODUCTION SHOPIFY LOCATION ID MAPPINGS
// ============================================================================
// Hardcoded-shape location mappings whose IDs come from Vercel environment
// variables — no values are hardcoded in this file.
//
// This is used as the last-resort fallback inside location-routing.ts when:
//   1. Supabase is unavailable or returns 0 active locations
//   2. The Hub API fallback also fails
//   3. The persisted file-based cache snapshot is empty
//
// VERCEL SETUP
// ─────────────────────────────────────────────────────────────────────────────
// Production environment  →  set SHOPIFY_STORE_MODE=production, then fill in:
//   SHOPIFY_PROD_LOCATION_GPS        Shopify location ID for GPS Warehouse (US)
//   SHOPIFY_PROD_LOCATION_GPS_UK     Shopify location ID for GPS UK Warehouse
//   SHOPIFY_PROD_LOCATION_STORD      Shopify location ID for STORD ATL
//   SHOPIFY_PROD_LOCATION_HK         Shopify location ID for HK Warehouse
//
// Test / Preview environment  →  set SHOPIFY_STORE_MODE=test, then fill in:
//   SHOPIFY_TEST_LOCATION_GPS
//   SHOPIFY_TEST_LOCATION_GPS_UK
//   SHOPIFY_TEST_LOCATION_STORD
//   SHOPIFY_TEST_LOCATION_HK
//
// HOW TO GET THE IDs
//   Shopify Admin → Settings → Locations → click a location → copy the
//   numeric ID from the URL: /admin/locations/<id>
//   or via REST: GET /admin/api/2024-07/locations.json
// ============================================================================

import { config } from "@/lib/config";
import type { LocationMapping } from "@/lib/services/location-routing";

const STORE = "im8";

/**
 * Builds the static location mappings from the currently active Shopify
 * credential set (resolved via SHOPIFY_STORE_MODE / NODE_ENV in config.ts).
 *
 * Returns only entries whose location ID is non-empty — partially configured
 * stores are handled gracefully.
 */
function buildProductionLocationMappings(): LocationMapping[] {
  const locs = config.shopify.im8.locations;

  const entries: Array<Omit<LocationMapping, "active"> & { shopifyLocationId: string }> = [
    // -------------------------------------------------------------------------
    // GPS Warehouse (US — Atlanta, GA)
    // Primary fulfillment for US, CA, MX, AU, NZ, JP, KR, IN orders.
    // -------------------------------------------------------------------------
    {
      id: "static-gps-us",
      name: "GPS Warehouse",
      shopifyLocationId: locs.gps,
      warehouseName: "GPS Warehouse",
      dynamicsDataAreaId: "U001",
      countryDataAreaMapping: [],
      store: STORE,
    },

    // -------------------------------------------------------------------------
    // GPS UK Warehouse (London, Heathrow)
    // Primary fulfillment for GB and EU/EEA orders.
    // -------------------------------------------------------------------------
    {
      id: "static-gps-uk",
      name: "GPS UK Warehouse",
      shopifyLocationId: locs.gpsUk,
      warehouseName: "GPS UK Warehouse",
      dynamicsDataAreaId: "H007",
      countryDataAreaMapping: [],
      store: STORE,
    },

    // -------------------------------------------------------------------------
    // STORD ATL Location (Atlanta, GA)
    // Used for STORD-fulfilled US orders (detected via fulfillment_service tag).
    // -------------------------------------------------------------------------
    {
      id: "static-stord-atl",
      name: "STORD ATL Location",
      shopifyLocationId: locs.stord,
      warehouseName: "STORD ATL Location",
      dynamicsDataAreaId: "U001",
      countryDataAreaMapping: [],
      store: STORE,
    },

    // -------------------------------------------------------------------------
    // HK Warehouse (Hong Kong)
    // Primary fulfillment for HK, SG, MY, TH, VN, PH, ID, TW, MO orders.
    // -------------------------------------------------------------------------
    {
      id: "static-hk-warehouse",
      name: "HK Warehouse",
      shopifyLocationId: locs.hkWarehouse,
      warehouseName: "HK Warehouse",
      dynamicsDataAreaId: "H007",
      countryDataAreaMapping: [],
      store: STORE,
    },
  ];

  return entries
    .filter((e) => Boolean(e.shopifyLocationId))
    .map((e) => ({ ...e, active: true }));
}

/**
 * Static location mappings derived from the active Shopify env var set.
 * Evaluated once at module load; restart the process to pick up env changes.
 */
export const PRODUCTION_LOCATION_MAPPINGS: LocationMapping[] = buildProductionLocationMappings();

/**
 * Returns `true` when the process is running in a production-like environment.
 *
 * Explicitly set USE_STATIC_LOCATION_IDS=true to force static fallback in any
 * environment (useful for debugging or staging setups without Supabase).
 * Set USE_STATIC_LOCATION_IDS=false to disable even in production.
 */
export function isProductionEnvironment(): boolean {
  if (process.env.USE_STATIC_LOCATION_IDS === "true") return true;
  if (process.env.USE_STATIC_LOCATION_IDS === "false") return false;
  return process.env.NODE_ENV === "production";
}
