// ============================================================================
// LOCATION ROUTING SERVICE
// ============================================================================
// Provides warehouse routing for orders and inventory sync
// Fetches location mappings directly from Supabase and caches them
// Used to determine which Dynamics DataAreaId to use for a given Shopify location

import { config } from "../config";
import { createClient } from "@supabase/supabase-js";

interface LocationMapping {
  id: string;
  name: string;
  shopifyLocationId: string;
  warehouseName: string | null;
  dynamicsDataAreaId: string | null;
  store: string; // 'im8' or 'circledna'
  active: boolean;
}

interface LocationRoutingCache {
  mappings: LocationMapping[];
  lastFetched: Date;
  ttl: number; // Time to live in milliseconds (default: 5 minutes)
}

let locationCache: LocationRoutingCache | null = null;
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

/**
 * Fetch location mappings directly from Supabase
 */
async function fetchLocationMappings(): Promise<LocationMapping[]> {
  if (!supabase) {
    console.warn("[LocationRouting] Supabase not configured, using fallback mappings");
    return getFallbackMappings();
  }

  try {
    // Fetch all active locations from Supabase
    const { data, error } = await supabase
      .from("locations" as any)
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("[LocationRouting] Error fetching from Supabase:", error);
      return getFallbackMappings();
    }

    // Map to location mapping format
    const mappings: LocationMapping[] = (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      shopifyLocationId: row.shopify_location_id || row.id,
      warehouseName: row.warehouse_name || null,
      dynamicsDataAreaId: row.dynamics_data_area_id || null,
      store: "im8", // Default store, can be enhanced later
      active: row.active !== false,
    }));

    console.log(`[LocationRouting] ✅ Fetched ${mappings.length} location mappings from Supabase`);
    return mappings;
  } catch (error) {
    console.error("[LocationRouting] Error fetching location mappings:", error);
    return getFallbackMappings();
  }
}

/**
 * Get fallback mappings from config (when Supabase is unavailable)
 * Uses warehouse-config.json and config.shopify.im8.locations
 */
function getFallbackMappings(): LocationMapping[] {
  const locations = config.shopify.im8.locations;
  const mappings: LocationMapping[] = [];

  // GPS Warehouse → U001
  if (locations.gps) {
    mappings.push({
      id: locations.gps,
      name: "GPS Warehouse",
      shopifyLocationId: locations.gps,
      warehouseName: "GPS Warehouse",
      dynamicsDataAreaId: "U001",
      store: "im8",
      active: true,
    });
  }

  // GPS UK Warehouse → H007
  if (locations.gpsUk) {
    mappings.push({
      id: locations.gpsUk,
      name: "GPS UK Warehouse",
      shopifyLocationId: locations.gpsUk,
      warehouseName: "GPS UK Warehouse",
      dynamicsDataAreaId: "H007",
      store: "im8",
      active: true,
    });
  }

  // STORD ATL Location → U001
  if (locations.stord) {
    mappings.push({
      id: locations.stord,
      name: "STORD ATL Location",
      shopifyLocationId: locations.stord,
      warehouseName: "STORD ATL Location",
      dynamicsDataAreaId: "U001",
      store: "im8",
      active: true,
    });
  }

  // HK Warehouse → H007
  if (locations.hkWarehouse) {
    mappings.push({
      id: locations.hkWarehouse,
      name: "HK Warehouse",
      shopifyLocationId: locations.hkWarehouse,
      warehouseName: "HK Warehouse",
      dynamicsDataAreaId: "H007",
      store: "im8",
      active: true,
    });
  }

  return mappings;
}

/**
 * Get location mappings (with caching)
 */
export async function getLocationMappings(forceRefresh = false): Promise<LocationMapping[]> {
  const now = Date.now();

  // Return cached data if still valid
  if (
    !forceRefresh &&
    locationCache &&
    now - locationCache.lastFetched.getTime() < locationCache.ttl
  ) {
    return locationCache.mappings;
  }

  // Fetch fresh data
  const mappings = await fetchLocationMappings();
  locationCache = {
    mappings,
    lastFetched: new Date(),
    ttl: DEFAULT_TTL,
  };

  console.log(`[LocationRouting] ✅ Loaded ${mappings.length} location mappings`);
  return mappings;
}

/**
 * Get DataAreaId for a Shopify location ID
 * This is the primary routing function for orders
 */
export async function getDataAreaIdForLocation(
  shopifyLocationId: string | number,
  store: string = "im8"
): Promise<string | null> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  if (mapping && mapping.dynamicsDataAreaId) {
    return mapping.dynamicsDataAreaId;
  }

  // Fallback to existing validation logic
  const { getDataAreaIdFromLocation } = await import("@/lib/utils/validation");
  return getDataAreaIdFromLocation(locationId);
}

/**
 * Get warehouse name for a Shopify location ID
 */
export async function getWarehouseNameForLocation(
  shopifyLocationId: string | number,
  store: string = "im8"
): Promise<string | null> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  return mapping?.warehouseName || null;
}

/**
 * Get all locations for a specific DataAreaId
 * Useful for inventory sync (multiple locations → one DataAreaId)
 */
export async function getLocationsForDataAreaId(
  dataAreaId: string,
  store: string = "im8"
): Promise<LocationMapping[]> {
  const mappings = await getLocationMappings();
  return mappings.filter(
    (m) => m.dynamicsDataAreaId === dataAreaId && m.store === store && m.active
  );
}

/**
 * Clear the location cache (useful for testing or forced refresh)
 */
export function clearLocationCache(): void {
  locationCache = null;
}
