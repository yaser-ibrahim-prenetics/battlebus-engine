// ============================================================================
// LOCATION ROUTING SERVICE
// ============================================================================
// Provides warehouse + DataAreaId routing for orders and inventory sync.
//
// Data model (Supabase `locations` table columns used here):
//   shopify_location_id       — Shopify numeric location ID
//   warehouse_name            — e.g. "GPS Warehouse", "GPS UK Warehouse"
//   dynamics_data_area_id     — default dataAreaId for this location
//   country_data_area_mapping — JSONB: [{country:"US",dataAreaId:"U001"}, ...]
//                               Overrides the default dataAreaId per country.
//                               When an order from country X is fulfilled at
//                               this location, the matching row's dataAreaId
//                               is used instead of dynamics_data_area_id.
//   active                    — soft-delete flag
//
// SQL migration (run once):
//   ALTER TABLE locations
//     ADD COLUMN IF NOT EXISTS country_data_area_mapping jsonb DEFAULT '[]'::jsonb;
//
// Routing priority for an order:
//   1. Location-level country override  (country_data_area_mapping match)
//   2. Location-level default           (dynamics_data_area_id)
//   3. Country-level routing table      (warehouse-config.json countryRouting)

import { createClient } from "@supabase/supabase-js";

// ============================================================================
// Types
// ============================================================================

export interface CountryDataAreaEntry {
  country: string; // ISO-2 code, e.g. "US", "GB"
  dataAreaId: string; // D365 data area, e.g. "U001", "H007"
}

export interface LocationMapping {
  id: string;
  name: string;
  shopifyLocationId: string;
  warehouseName: string | null;
  dynamicsDataAreaId: string | null;
  /** Per-country dataAreaId overrides for this location */
  countryDataAreaMapping: CountryDataAreaEntry[];
  store: string;
  active: boolean;
}

interface LocationRoutingCache {
  mappings: LocationMapping[];
  lastFetched: Date;
  ttl: number;
}

// ============================================================================
// Supabase client
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

// ============================================================================
// Cache
// ============================================================================

let locationCache: LocationRoutingCache | null = null;
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export function clearLocationCache(): void {
  locationCache = null;
}

// ============================================================================
// Row mapper
// ============================================================================

function rowToMapping(row: any): LocationMapping {
  let countryDataAreaMapping: CountryDataAreaEntry[] = [];
  if (Array.isArray(row.country_data_area_mapping)) {
    countryDataAreaMapping = row.country_data_area_mapping as CountryDataAreaEntry[];
  } else if (typeof row.country_data_area_mapping === "string") {
    try {
      countryDataAreaMapping = JSON.parse(row.country_data_area_mapping);
    } catch {
      countryDataAreaMapping = [];
    }
  }

  return {
    id: row.id,
    name: row.name,
    shopifyLocationId: String(row.shopify_location_id || row.id),
    warehouseName: row.warehouse_name || null,
    dynamicsDataAreaId: row.dynamics_data_area_id || null,
    countryDataAreaMapping,
    store: "im8",
    active: row.active !== false,
  };
}

// No hardcoded fallback mappings.
// Locations are the source of truth in Supabase, seeded from Shopify via webhooks
// or the /api/locations/seed endpoint.  When Supabase is unavailable the cache
// returns an empty array and routing falls back to the country-level table in
// warehouse-config.json.

// ============================================================================
// Fetch & cache
// ============================================================================

async function fetchLocationMappings(): Promise<LocationMapping[]> {
  if (!supabase) {
    console.warn(
      "[LocationRouting] Supabase not configured — no location mappings available. " +
        "Routing will fall back to country-level table."
    );
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("locations" as any)
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("[LocationRouting] Supabase fetch error:", error);
      return [];
    }

    const mappings = (data || []).map(rowToMapping);
    console.log(`[LocationRouting] ✅ Fetched ${mappings.length} location mappings from Supabase`);
    return mappings;
  } catch (err) {
    console.error("[LocationRouting] Unexpected error fetching mappings:", err);
    return [];
  }
}

export async function getLocationMappings(forceRefresh = false): Promise<LocationMapping[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    locationCache &&
    now - locationCache.lastFetched.getTime() < locationCache.ttl
  ) {
    return locationCache.mappings;
  }

  const mappings = await fetchLocationMappings();
  locationCache = { mappings, lastFetched: new Date(), ttl: DEFAULT_TTL };
  return mappings;
}

// ============================================================================
// Upsert (called by process-location-sync)
// ============================================================================

/**
 * Upsert a location into Supabase.
 *
 * For warehouse_name, dynamics_data_area_id and country_data_area_mapping:
 * - On CREATE  → write the auto-detected values as defaults.
 * - On UPDATE  → preserve existing values if already manually configured
 *   (only update address/active/name fields from Shopify).
 *
 * This ensures manual routing config in Hub is never overwritten by a
 * Shopify `locations/update` webhook.
 */
export async function upsertLocation(params: {
  shopifyLocationId: string;
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
  active: boolean;
  fulfillmentServiceId?: string | null;
  /** Auto-detected warehouse name (used only when creating a new row) */
  defaultWarehouseName?: string | null;
  /** Auto-detected dataAreaId (used only when creating a new row) */
  defaultDataAreaId?: string | null;
  isCreate: boolean;
}): Promise<void> {
  if (!supabase) {
    console.warn("[LocationRouting] Supabase not configured — skipping upsert");
    return;
  }

  try {
    // Check if row already exists
    const { data: existing } = await supabase
      .from("locations" as any)
      .select("id, warehouse_name, dynamics_data_area_id, country_data_area_mapping")
      .eq("shopify_location_id", params.shopifyLocationId)
      .maybeSingle();

    const now = new Date().toISOString();

    if (existing) {
      // UPDATE — only touch address fields + active/name; preserve routing config
      const { error } = await supabase
        .from("locations" as any)
        .update({
          name: params.name,
          address_line1: params.addressLine1 ?? null,
          address_line2: params.addressLine2 ?? null,
          city: params.city ?? null,
          province: params.province ?? null,
          country: params.country ?? null,
          zip: params.zip ?? null,
          phone: params.phone ?? null,
          active: params.active,
          fulfillment_service_id: params.fulfillmentServiceId ?? null,
          updated_at: now,
        } as any)
        .eq("shopify_location_id", params.shopifyLocationId);

      if (error) {
        console.error("[LocationRouting] Error updating location:", error);
      } else {
        console.log(
          `[LocationRouting] ✅ Updated location ${params.shopifyLocationId} (preserved routing config)`
        );
      }
    } else {
      // INSERT — write everything including default routing values
      const { error } = await supabase.from("locations" as any).insert({
        id: params.shopifyLocationId,
        shopify_location_id: params.shopifyLocationId,
        name: params.name,
        warehouse_name: params.defaultWarehouseName ?? null,
        dynamics_data_area_id: params.defaultDataAreaId ?? null,
        country_data_area_mapping: [] as any,
        address_line1: params.addressLine1 ?? null,
        address_line2: params.addressLine2 ?? null,
        city: params.city ?? null,
        province: params.province ?? null,
        country: params.country ?? null,
        zip: params.zip ?? null,
        phone: params.phone ?? null,
        active: params.active,
        fulfillment_service_id: params.fulfillmentServiceId ?? null,
        created_at: now,
        updated_at: now,
      } as any);

      if (error) {
        console.error("[LocationRouting] Error inserting location:", error);
      } else {
        console.log(
          `[LocationRouting] ✅ Created location ${params.shopifyLocationId} with default routing: ${params.defaultWarehouseName} / ${params.defaultDataAreaId}`
        );
      }
    }

    // Invalidate cache so the next order lookup gets fresh data
    clearLocationCache();
  } catch (err) {
    console.error("[LocationRouting] Unexpected error in upsertLocation:", err);
  }
}

/**
 * Soft-delete a location in Supabase.
 */
export async function deactivateLocation(shopifyLocationId: string): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("locations" as any)
      .update({ active: false, updated_at: new Date().toISOString() } as any)
      .eq("shopify_location_id", shopifyLocationId);

    if (error) {
      console.error("[LocationRouting] Error deactivating location:", error);
    } else {
      console.log(`[LocationRouting] ✅ Deactivated location ${shopifyLocationId}`);
      clearLocationCache();
    }
  } catch (err) {
    console.error("[LocationRouting] Unexpected error in deactivateLocation:", err);
  }
}

// ============================================================================
// Lookup functions (used by order routing)
// ============================================================================

/**
 * Get the dataAreaId for a specific location + country combination.
 *
 * Resolution order:
 *   1. country_data_area_mapping entry matching countryCode
 *   2. dynamics_data_area_id (location default)
 *   3. null (caller falls back to country-level routing)
 */
export async function getDataAreaIdForLocationAndCountry(
  shopifyLocationId: string | number,
  countryCode: string,
  store = "im8"
): Promise<string | null> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);
  const code = (countryCode || "").toUpperCase();

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  if (!mapping) return null;

  // 1. Per-country override
  const entry = mapping.countryDataAreaMapping.find((e) => e.country.toUpperCase() === code);
  if (entry?.dataAreaId) {
    console.log(
      `[LocationRouting] Location ${locationId} country ${code} → dataAreaId ${entry.dataAreaId} (country override)`
    );
    return entry.dataAreaId;
  }

  // 2. Location default
  if (mapping.dynamicsDataAreaId) {
    console.log(
      `[LocationRouting] Location ${locationId} country ${code} → dataAreaId ${mapping.dynamicsDataAreaId} (location default)`
    );
    return mapping.dynamicsDataAreaId;
  }

  return null;
}

/**
 * Legacy: get dataAreaId for location without country context.
 * Returns the location default, no per-country resolution.
 */
export async function getDataAreaIdForLocation(
  shopifyLocationId: string | number,
  store = "im8"
): Promise<string | null> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  return mapping?.dynamicsDataAreaId ?? null;
}

/**
 * Get warehouse name for a Shopify location ID.
 */
export async function getWarehouseNameForLocation(
  shopifyLocationId: string | number,
  store = "im8"
): Promise<string | null> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  return mapping?.warehouseName ?? null;
}

/**
 * Get all locations for a specific DataAreaId.
 * Used by inventory sync.
 */
export async function getLocationsForDataAreaId(
  dataAreaId: string,
  store = "im8"
): Promise<LocationMapping[]> {
  const mappings = await getLocationMappings();
  return mappings.filter(
    (m) => m.dynamicsDataAreaId === dataAreaId && m.store === store && m.active
  );
}
