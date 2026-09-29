// ============================================================================
// LOCATION ROUTING SERVICE
// ============================================================================
// Provides warehouse + DataAreaId routing for orders and inventory sync.
//
// Data model (Cloud SQL `locations` table columns used here):
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

import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import warehouseConfig from "../mappings/warehouse-config.json";
import {
  ACTIVE_SHOPIFY_LOCATION_MAPPINGS,
  isProductionEnvironment,
} from "../mappings/production-location-ids";

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

interface LocationCacheSnapshot {
  fetchedAt: string;
  mappings: LocationMapping[];
}

// ============================================================================
// Database configuration
// ============================================================================

const databaseAvailable = () => isDatabaseConfigured();

// ============================================================================
// Cache
// ============================================================================

let locationCache: LocationRoutingCache | null = null;
const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour
const CACHE_FILE_PATH =
  process.env.LOCATION_CONFIG_CACHE_FILE_PATH || "/tmp/battle-bus/location-mappings-cache.json";

export function clearLocationCache(): void {
  locationCache = null;
}

async function writeLocationSnapshot(mappings: LocationMapping[]): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE_PATH), { recursive: true });
    const payload: LocationCacheSnapshot = {
      fetchedAt: new Date().toISOString(),
      mappings,
    };
    await writeFile(CACHE_FILE_PATH, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.warn("[LocationRouting] Failed to write cache snapshot:", error);
  }
}

async function readLocationSnapshot(): Promise<LocationMapping[]> {
  try {
    const raw = await readFile(CACHE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LocationCacheSnapshot;
    if (!Array.isArray(parsed?.mappings)) return [];
    return parsed.mappings.filter((m) => m && m.active !== false);
  } catch {
    return [];
  }
}

// ============================================================================
// Row mapper
// ============================================================================

function rowToMapping(row: any): LocationMapping {
  let countryDataAreaMapping: CountryDataAreaEntry[] = [];
  const rawCountryMapping =
    row.country_data_area_mapping ?? row.countryDataAreaMapping ?? row.countryRouting;
  if (Array.isArray(rawCountryMapping)) {
    countryDataAreaMapping = rawCountryMapping as CountryDataAreaEntry[];
  } else if (typeof rawCountryMapping === "string") {
    try {
      countryDataAreaMapping = JSON.parse(rawCountryMapping);
    } catch {
      countryDataAreaMapping = [];
    }
  }

  return {
    id: String(row.id),
    name: String(row.name || row.warehouse_name || row.warehouseName || "Unknown Location"),
    shopifyLocationId: String(row.shopify_location_id || row.shopifyLocationId || row.id),
    warehouseName: row.warehouse_name || row.warehouseName || null,
    dynamicsDataAreaId: row.dynamics_data_area_id || row.dynamicsDataAreaId || null,
    countryDataAreaMapping,
    store: row.store || "im8",
    active: row.active !== false,
  };
}

// Location source-of-truth priority:
//   1. Cloud SQL `locations` table  (live — preferred)
//   2. Battle Hub /api/locations/mappings  (fallback when PostgreSQL is unavailable)
//   3. Persisted file-based cache snapshot  (fallback when both APIs are down)
//   4. Hardcoded production IDs  (last-resort for production deployments)
// After (1)–(3), we **merge** ACTIVE_SHOPIFY_LOCATION_MAPPINGS (SHOPIFY_PROD_* or
// SHOPIFY_TEST_* per SHOPIFY_STORE_MODE) for any shopifyLocationId not already in the list.
// Country-level routing from warehouse-config.json kicks in only for
// determineWarehouse(), which is used when no location ID can be resolved at all.

/**
 * Adds env location rows for the active store mode (prod vs test) when Hub/PostgreSQL omits that ID.
 */
function mergeStaticProductionLocationOverrides(dynamic: LocationMapping[]): LocationMapping[] {
  if (!ACTIVE_SHOPIFY_LOCATION_MAPPINGS.length) return dynamic;
  const byId = new Map<string, LocationMapping>();
  for (const m of dynamic) {
    byId.set(m.shopifyLocationId, m);
  }
  let added = 0;
  for (const s of ACTIVE_SHOPIFY_LOCATION_MAPPINGS) {
    if (!s.shopifyLocationId) continue;
    if (!byId.has(s.shopifyLocationId)) {
      byId.set(s.shopifyLocationId, { ...s });
      added++;
    }
  }
  if (added > 0) {
    console.log(
      `[LocationRouting] Merged ${added} location(s) from active SHOPIFY_PROD_* or SHOPIFY_TEST_* env (per SHOPIFY_STORE_MODE); IDs missing from Hub/Supabase`
    );
  }
  return Array.from(byId.values());
}

// ============================================================================
// Fetch & cache
// ============================================================================

async function fetchLocationMappings(): Promise<LocationMapping[]> {
  async function fetchFromHubApi(reason: string): Promise<LocationMapping[]> {
    try {
      const hubUrl = config.csPlatform.baseUrl;
      const serviceSecret =
        config.csPlatform.webhookSecret ||
        process.env.INTERNAL_SERVICE_SECRET ||
        process.env.BATTLE_BUS_WEBHOOK_SECRET ||
        "";
      if (!serviceSecret) {
        console.warn(
          `[LocationRouting] Hub API fallback skipped (${reason}): missing CS_PLATFORM_WEBHOOK_SECRET/INTERNAL_SERVICE_SECRET`
        );
        return [];
      }
      const response = await fetch(`${hubUrl}/api/locations/mappings`, {
        headers: {
          Authorization: `Bearer ${serviceSecret}`,
          "x-battle-bus-webhook-secret": serviceSecret,
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[LocationRouting] Hub API fallback failed (${reason}): HTTP ${response.status} ${body}`
        );
        return [];
      }
      const payload = await response.json();
      const rows = Array.isArray(payload?.locations) ? payload.locations : [];
      const mappings: LocationMapping[] = rows
        .map((row: any) => rowToMapping(row))
        .filter((m: LocationMapping) => m.active);
      console.log(
        `[LocationRouting] ✅ Loaded ${mappings.length} location mappings from Hub API fallback (${reason})`
      );
      return mappings;
    } catch (error) {
      console.warn(`[LocationRouting] Hub API fallback failed (${reason}):`, error);
      return [];
    }
  }

  if (!databaseAvailable()) {
    console.warn("[LocationRouting] PostgreSQL not configured — trying Hub API fallback");
    return fetchFromHubApi("database_not_configured");
  }

  try {
    const result = await queryDatabase(
      `SELECT * FROM public.locations WHERE active = true ORDER BY name ASC`
    );
    const mappings = result.rows.map(rowToMapping);
    if (mappings.length === 0) {
      console.warn("[LocationRouting] PostgreSQL returned 0 active locations — trying Hub API fallback");
      return fetchFromHubApi("database_empty");
    }
    console.log(`[LocationRouting] ✅ Fetched ${mappings.length} location mappings from PostgreSQL`);
    return mappings;
  } catch (err) {
    console.error("[LocationRouting] Unexpected error fetching mappings:", err);
    return fetchFromHubApi("database_exception");
  }
}

export async function getLocationMappings(forceRefresh = false): Promise<LocationMapping[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    locationCache &&
    now - locationCache.lastFetched.getTime() < locationCache.ttl
  ) {
    return mergeStaticProductionLocationOverrides(locationCache.mappings);
  }

  const mappings = await fetchLocationMappings();
  if (mappings.length > 0) {
    const finalized = mergeStaticProductionLocationOverrides(mappings);
    locationCache = { mappings: finalized, lastFetched: new Date(), ttl: DEFAULT_TTL };
    await writeLocationSnapshot(finalized);
    return finalized;
  }

  if (locationCache?.mappings?.length) {
    console.warn("[LocationRouting] Using stale in-memory cache (refresh returned 0 mappings)");
    return mergeStaticProductionLocationOverrides(locationCache.mappings);
  }

  const snapshotMappings = await readLocationSnapshot();
  if (snapshotMappings.length > 0) {
    console.warn(
      `[LocationRouting] Using persisted cache snapshot with ${snapshotMappings.length} mappings`
    );
    const finalized = mergeStaticProductionLocationOverrides(snapshotMappings);
    locationCache = {
      mappings: finalized,
      lastFetched: new Date(),
      ttl: DEFAULT_TTL,
    };
    return finalized;
  }

  // Last-resort: use hardcoded production location IDs when running in a
  // production environment and all dynamic sources are unavailable.
  if (isProductionEnvironment() && ACTIVE_SHOPIFY_LOCATION_MAPPINGS.length > 0) {
    console.warn(
      `[LocationRouting] ⚠️ All dynamic sources exhausted — falling back to ${ACTIVE_SHOPIFY_LOCATION_MAPPINGS.length} env location mappings (active store mode). ` +
        `Check PostgreSQL connectivity and Battle Hub availability.`
    );
    locationCache = {
      mappings: ACTIVE_SHOPIFY_LOCATION_MAPPINGS,
      lastFetched: new Date(),
      ttl: DEFAULT_TTL,
    };
    return ACTIVE_SHOPIFY_LOCATION_MAPPINGS;
  }

  locationCache = { mappings: [], lastFetched: new Date(), ttl: DEFAULT_TTL };
  return [];
}

export async function refreshLocationMappings(reason = "manual"): Promise<{
  refreshed: boolean;
  count: number;
  reason: string;
}> {
  const mappings = await getLocationMappings(true);
  return {
    refreshed: true,
    count: mappings.length,
    reason,
  };
}

export function getLocationCacheStatus(): {
  cacheFilePath: string;
  hasMemoryCache: boolean;
  memoryCount: number;
  lastFetched: string | null;
  ttlMs: number;
} {
  return {
    cacheFilePath: CACHE_FILE_PATH,
    hasMemoryCache: !!locationCache,
    memoryCount: locationCache?.mappings.length || 0,
    lastFetched: locationCache?.lastFetched.toISOString() || null,
    ttlMs: DEFAULT_TTL,
  };
}

export async function getLocationRoutingDebugContext(
  shopifyLocationId: string | number,
  countryCode: string,
  store = "im8"
): Promise<string> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);
  const code = (countryCode || "").toUpperCase();

  const matchingLocation = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  return JSON.stringify({
    requestedLocationId: locationId,
    requestedCountryCode: code,
    store,
    totalLoadedLocations: mappings.length,
    matchingLocation: matchingLocation
      ? {
          id: matchingLocation.id,
          name: matchingLocation.name,
          shopifyLocationId: matchingLocation.shopifyLocationId,
          warehouseName: matchingLocation.warehouseName,
          dynamicsDataAreaId: matchingLocation.dynamicsDataAreaId,
          countryDataAreaMapping: matchingLocation.countryDataAreaMapping,
          active: matchingLocation.active,
        }
      : null,
    loadedLocations: mappings.slice(0, 25).map((m) => ({
      id: m.id,
      name: m.name,
      shopifyLocationId: m.shopifyLocationId,
      warehouseName: m.warehouseName,
      dynamicsDataAreaId: m.dynamicsDataAreaId,
      countryOverrides: m.countryDataAreaMapping.map(
        (entry) => `${entry.country}:${entry.dataAreaId}`
      ),
      active: m.active,
    })),
  });
}

// ============================================================================
// Upsert (called by process-location-sync)
// ============================================================================

/**
 * Upsert a location into Cloud SQL.
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
  if (!databaseAvailable()) {
    console.warn("[LocationRouting] PostgreSQL not configured — skipping upsert");
    return;
  }

  try {
    // Check if row already exists
    const existingResult = await queryDatabase<{ id: string }>(
      `SELECT id FROM public.locations WHERE shopify_location_id = $1 LIMIT 1`,
      [params.shopifyLocationId]
    );
    const existing = existingResult.rows[0];

    if (existing) {
      // UPDATE — only touch address fields + active/name; preserve routing config
      await queryDatabase(
        `UPDATE public.locations
         SET name = $2, address_line1 = $3, address_line2 = $4, city = $5,
             province = $6, country = $7, zip = $8, phone = $9, active = $10,
             fulfillment_service_id = $11, updated_at = now()
         WHERE shopify_location_id = $1`,
        [
          params.shopifyLocationId,
          params.name,
          params.addressLine1 ?? null,
          params.addressLine2 ?? null,
          params.city ?? null,
          params.province ?? null,
          params.country ?? null,
          params.zip ?? null,
          params.phone ?? null,
          params.active,
          params.fulfillmentServiceId ?? null,
        ]
      );
      console.log(
        `[LocationRouting] ✅ Updated location ${params.shopifyLocationId} (preserved routing config)`
      );
    } else {
      // INSERT — write everything including default routing values
      await queryDatabase(
        `INSERT INTO public.locations (
           id, shopify_location_id, name, warehouse_name, dynamics_data_area_id,
           country_data_area_mapping, address_line1, address_line2, city, province,
           country, zip, phone, active, fulfillment_service_id
         ) VALUES ($1, $1, $2, $3, $4, '[]'::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          params.shopifyLocationId,
          params.name,
          params.defaultWarehouseName ?? null,
          params.defaultDataAreaId ?? null,
          params.addressLine1 ?? null,
          params.addressLine2 ?? null,
          params.city ?? null,
          params.province ?? null,
          params.country ?? null,
          params.zip ?? null,
          params.phone ?? null,
          params.active,
          params.fulfillmentServiceId ?? null,
        ]
      );
      console.log(
        `[LocationRouting] ✅ Created location ${params.shopifyLocationId} with default routing: ${params.defaultWarehouseName} / ${params.defaultDataAreaId}`
      );
    }

    // Invalidate cache so the next order lookup gets fresh data
    clearLocationCache();
  } catch (err) {
    console.error("[LocationRouting] Unexpected error in upsertLocation:", err);
  }
}

/**
 * Soft-delete a location in Cloud SQL.
 */
export async function deactivateLocation(shopifyLocationId: string): Promise<void> {
  if (!databaseAvailable()) return;
  try {
    await queryDatabase(
      `UPDATE public.locations SET active = false, updated_at = now() WHERE shopify_location_id = $1`,
      [shopifyLocationId]
    );
    console.log(`[LocationRouting] ✅ Deactivated location ${shopifyLocationId}`);
    clearLocationCache();
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
 * Single-call lookup returning both dataAreaId and warehouseName.
 * Avoids loading + scanning the mappings array twice when callers need both.
 */
export async function getLocationRouting(
  shopifyLocationId: string | number,
  countryCode: string,
  store = "im8"
): Promise<{ dataAreaId: string | null; warehouseName: string | null }> {
  const mappings = await getLocationMappings();
  const locationId = String(shopifyLocationId);
  const code = (countryCode || "").toUpperCase();

  const mapping = mappings.find(
    (m) => m.shopifyLocationId === locationId && m.store === store && m.active
  );

  if (!mapping) return { dataAreaId: null, warehouseName: null };

  const entry = mapping.countryDataAreaMapping.find((e) => e.country.toUpperCase() === code);
  const dataAreaId = entry?.dataAreaId || mapping.dynamicsDataAreaId || null;

  return { dataAreaId, warehouseName: mapping.warehouseName ?? null };
}

/**
 * Find the first active Battle Hub location whose warehouse_name matches.
 * Used as a last-resort when Shopify only assigns a virtual location but we
 * know the expected warehouse from the static country-routing table.
 */
export async function findLocationByWarehouseName(
  warehouseName: string,
  store = "im8"
): Promise<LocationMapping | null> {
  const mappings = await getLocationMappings();
  const name = (warehouseName || "").trim().toLowerCase();
  const match = mappings.find(
    (m) =>
      m.active &&
      m.store === store &&
      m.warehouseName !== null &&
      m.dynamicsDataAreaId !== null &&
      !String(m.warehouseName || "")
        .toLowerCase()
        .includes("virtual") &&
      String(m.warehouseName || "")
        .trim()
        .toLowerCase() === name
  );
  return match || null;
}

// ---------------------------------------------------------------------------
// Stord: Shopify location ID missing from Hub (rename / new warehouse in Shopify)
// ---------------------------------------------------------------------------

type OrderLineForStordCheck = {
  requires_shipping?: boolean;
  gift_card?: boolean;
  fulfillment_service?: string;
};

/** True when every shippable line uses Shopify's Stord fulfillment service. */
export function orderShippableLinesAllUseStordFulfillment(order: {
  line_items?: OrderLineForStordCheck[];
}): boolean {
  const lines = order.line_items || [];
  const shippable = lines.filter((li) => li?.requires_shipping !== false && li?.gift_card !== true);
  if (shippable.length === 0) return false;
  return shippable.every((li) => String(li?.fulfillment_service || "").toLowerCase() === "stord");
}

/**
 * Which Stord Battle Hub profile to use for a ship-to country.
 * Mirrors EU vs non-EU split (same country bucket as GPS UK routing).
 */
export function stordWarehouseNameForShipCountry(
  countryCode: string
): "STORD ATL Location" | "STORD EU Location" {
  const code = (countryCode || "").toUpperCase();
  const table = warehouseConfig.countryRouting as Record<string, string>;
  return table[code] === "GPS UK Warehouse" ? "STORD EU Location" : "STORD ATL Location";
}

/**
 * When the fulfillment FO points at a Shopify location ID that is not yet in
 * Battle Hub, but the order is only Stord-fulfilled lines, route using the
 * existing STORD ATL or STORD EU location row (warehouse + dataAreaId).
 */
export async function resolveStordHubWhenFulfillmentLocationUnmapped(
  order: { line_items?: OrderLineForStordCheck[] },
  countryCode: string,
  store = "im8"
): Promise<{
  warehouseName: string;
  dataAreaId: string;
  hubShopifyLocationId: string;
} | null> {
  if (!orderShippableLinesAllUseStordFulfillment(order)) return null;

  const whName = stordWarehouseNameForShipCountry(countryCode);
  const hub = await findLocationByWarehouseName(whName, store);
  if (!hub?.shopifyLocationId || !hub.warehouseName || !hub.dynamicsDataAreaId) {
    return null;
  }

  const dataAreaId = await getDataAreaIdForLocationAndCountry(
    hub.shopifyLocationId,
    countryCode,
    store
  );
  if (!dataAreaId) return null;

  return {
    warehouseName: hub.warehouseName,
    dataAreaId,
    hubShopifyLocationId: hub.shopifyLocationId,
  };
}

/**
 * Canonical STORD routing:
 * - EU ship-to countries must route to STORD EU (H007)
 * - Non-EU ship-to countries must route to STORD ATL (U001)
 *
 * This intentionally enforces canonical dataAreaId from warehouse-config.json
 * even when Battle Hub location rows are misconfigured.
 */
export async function resolveStordEuOverrideForMappedLocation(
  warehouseName: string | null | undefined,
  countryCode: string,
  store = "im8"
): Promise<{
  warehouseName: string;
  dataAreaId: string;
  hubShopifyLocationId: string;
} | null> {
  const normalizedWarehouse = String(warehouseName || "")
    .trim()
    .toLowerCase();
  if (!normalizedWarehouse.includes("stord")) {
    return null;
  }

  const targetWarehouseName = stordWarehouseNameForShipCountry(countryCode);

  const targetHub = await findLocationByWarehouseName(targetWarehouseName, store);
  if (!targetHub?.shopifyLocationId || !targetHub.warehouseName) {
    return null;
  }

  // Canonical source of truth for STORD dataAreaId should be warehouse-config.
  // This avoids routing STORD EU orders to U001 when a Hub row is stale/misconfigured.
  const canonicalDataAreaId = String(
    (warehouseConfig as any)?.warehouses?.[targetWarehouseName]?.dataAreaId || ""
  )
    .trim()
    .toUpperCase();

  const dataAreaId =
    canonicalDataAreaId ||
    (await getDataAreaIdForLocationAndCountry(
      targetHub.shopifyLocationId,
      countryCode,
      store
    ));
  if (!dataAreaId) return null;

  return {
    warehouseName: targetHub.warehouseName,
    dataAreaId,
    hubShopifyLocationId: targetHub.shopifyLocationId,
  };
}

/**
 * Get the Shopify location ID for a warehouse name.
 * Used by inventory-sync and cron-gps-sync to replace hardcoded location IDs.
 */
export async function getLocationIdForWarehouse(
  warehouseName: string,
  store: string = "im8"
): Promise<string | null> {
  const mapping = await findLocationByWarehouseName(warehouseName, store);
  return mapping?.shopifyLocationId ?? null;
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
