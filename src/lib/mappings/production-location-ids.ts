// ============================================================================
// PRODUCTION SHOPIFY LOCATION ID MAPPINGS
// ============================================================================
// Hardcoded-shape location mappings whose IDs come from Vercel environment
// variables — no values are hardcoded in this file.
//
// In location-routing.ts these rows are:
//   • Merged into Hub/Supabase results when a SHOPIFY_*_LOCATION_* ID is missing there
//   • Used as last-resort fallback when Supabase, Hub, and the file snapshot all yield nothing
//
// Which env vars apply: exactly one set, chosen by SHOPIFY_STORE_MODE (see config.ts).
//   SHOPIFY_STORE_MODE=production  →  SHOPIFY_PROD_LOCATION_GPS, _GPS_UK, _STORD, _HK
//   SHOPIFY_STORE_MODE=test        →  SHOPIFY_TEST_LOCATION_GPS, _GPS_UK, _STORD, _HK
// If unset, NODE_ENV=production implies production mode; otherwise test.
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
 * Builds env-backed location rows for the **active** store mode only:
 * prod vars when mode is production, test vars when mode is test.
 */
function buildActiveShopifyLocationMappings(): LocationMapping[] {
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

  return entries.filter((e) => Boolean(e.shopifyLocationId)).map((e) => ({ ...e, active: true }));
}

/**
 * Env-backed location mappings for the current SHOPIFY_STORE_MODE (PROD_* vs TEST_*).
 * Evaluated once at module load; restart the process to pick up env changes.
 */
export const ACTIVE_SHOPIFY_LOCATION_MAPPINGS: LocationMapping[] =
  buildActiveShopifyLocationMappings();

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
