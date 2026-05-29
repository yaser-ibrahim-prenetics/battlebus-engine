// ============================================================================
// WAREHOUSE ROUTING HELPERS
// ============================================================================
// Ported from spock-store src/component/warehouse.ts
//
// Routing chain: countryCode → countryRouting[country] → warehouseName → dataAreaId
//
// The full routing table lives in warehouse-config.json (countryRouting section).
// Per-environment overrides can be applied via COUNTRY_ROUTING_OVERRIDES env var
// (JSON string mapping country codes to warehouse names), e.g.:
//   COUNTRY_ROUTING_OVERRIDES='{"AU":"HK Warehouse","JP":"HK Warehouse"}'

import warehouseConfig from "../mappings/warehouse-config.json";
import { IGpsIndividualFulfilment } from "../types/gps";

// ============================================================================
// Types
// ============================================================================

export type WarehouseName = keyof typeof warehouseConfig.warehouses;

export interface WarehouseConfig {
  countryCode: string;
  name: string;
  orderingCustomerAccountNumber: string;
  dimensionValue: string;
  project: string;
  dataAreaId: string;
  gpsCode?: string;
  logisticsChannel?: string;
  fulfilment: {
    shippingSiteId: string;
    shippingWarehouseId: string;
    shippingWarehouseLocationId: string;
  };
  return: {
    shippingSiteId: string;
    shippingWarehouseId: string;
    shippingWarehouseLocationId: string;
  };
  item: {
    tax: string;
    refund: string;
    shipping: string;
  };
}

export interface RoutingResult {
  warehouseName: WarehouseName;
  dataAreaId: string;
  countryCode: string;
  source: "location" | "country_override" | "country_config" | "default";
}

// ============================================================================
// Env-var override loader (parsed once per cold-start)
// ============================================================================

function loadCountryOverrides(): Record<string, WarehouseName> {
  const raw = process.env.COUNTRY_ROUTING_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const validWarehouses = Object.keys(warehouseConfig.warehouses);
    const result: Record<string, WarehouseName> = {};
    for (const [country, warehouse] of Object.entries(parsed)) {
      if (validWarehouses.includes(warehouse)) {
        result[country.toUpperCase()] = warehouse as WarehouseName;
      } else {
        console.warn(
          `[Routing] COUNTRY_ROUTING_OVERRIDES: unknown warehouse "${warehouse}" for country "${country}" — skipped`
        );
      }
    }
    return result;
  } catch {
    console.error("[Routing] COUNTRY_ROUTING_OVERRIDES is not valid JSON — ignoring");
    return {};
  }
}

let _countryOverrides: Record<string, WarehouseName> | null = null;
function getCountryOverrides(): Record<string, WarehouseName> {
  if (!_countryOverrides) _countryOverrides = loadCountryOverrides();
  return _countryOverrides;
}

// ============================================================================
// Warehouse Detection Functions
// ============================================================================

/**
 * Check if warehouse is a GPS warehouse
 */
export function isGpsWarehouse(warehouseName: string): boolean {
  return warehouseConfig.gpsWarehouses.includes(warehouseName);
}

/**
 * Check if warehouse is GPS UK specifically
 */
export function isGpsUkWarehouse(warehouseName: string): boolean {
  return warehouseName === "GPS UK Warehouse";
}

/**
 * Check if warehouse is a STORD warehouse
 */
export function isStordWarehouse(warehouseName: string): boolean {
  return warehouseConfig.stordWarehouses.includes(warehouseName);
}

/**
 * Get warehouse configuration by name
 */
export function getWarehouseConfig(warehouseName: string): WarehouseConfig {
  const config = warehouseConfig.warehouses[warehouseName as WarehouseName];
  if (!config) {
    throw new Error(`Unknown warehouse: ${warehouseName}`);
  }
  return config as WarehouseConfig;
}

/**
 * Validate warehouse exists in static warehouse config.
 */
export function isKnownWarehouseName(warehouseName: string): warehouseName is WarehouseName {
  return Object.prototype.hasOwnProperty.call(warehouseConfig.warehouses, warehouseName);
}

/**
 * Resolve a warehouse profile from D365 dataAreaId.
 * Used when a Shopify location name is not one of the static warehouse keys.
 */
export function getWarehouseConfigForDataAreaId(dataAreaId: string): WarehouseConfig {
  const normalized = (dataAreaId || "").toUpperCase();
  const warehouses = warehouseConfig.warehouses as Record<string, WarehouseConfig>;

  // Prefer canonical profiles for each data area.
  const preferredProfileByArea: Record<string, string> = {
    U001: "GPS Warehouse",
    H007: "GPS UK Warehouse",
    H005: "HK Warehouse",
  };

  const preferred = preferredProfileByArea[normalized];
  if (preferred && warehouses[preferred]) {
    return warehouses[preferred];
  }

  const matched = Object.values(warehouses).find(
    (cfg) => (cfg.dataAreaId || "").toUpperCase() === normalized
  );
  if (matched) return matched;

  throw new Error(`No warehouse profile found for dataAreaId: ${dataAreaId}`);
}

/**
 * Get default warehouse configuration
 */
export function getDefaultWarehouse(): WarehouseConfig {
  return getWarehouseConfig(warehouseConfig.defaultWarehouse);
}

// ============================================================================
// Data Area Functions
// ============================================================================

/**
 * Get data area ID from warehouse name
 */
export function getDataAreaId(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  return config.dataAreaId;
}

/**
 * Get ordering customer account number from warehouse
 * Dynamically derives from dataAreaId if not explicitly set in config
 */
export function getOrderingCustomerAccountNumber(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);

  // If explicitly set in config, use it
  if (config.orderingCustomerAccountNumber) {
    return config.orderingCustomerAccountNumber;
  }

  // Otherwise, derive from dataAreaId
  return deriveCustomerAccountNumber(config.dataAreaId);
}

/**
 * Derive customer account number from data area ID
 * Pattern: {dataAreaId}-C{number}
 * - U001 (US): U001-C000000006 — matches spock US snapshots + production STORD/GPS path
 * - H007 (UK): H007-C000000001
 * - H005 (HK): H005-C000000001
 */
function deriveCustomerAccountNumber(dataAreaId: string): string {
  // Map data area to customer account suffix
  const customerAccountSuffix: Record<string, string> = {
    U001: "C000000006", // US production (spock US order tests / STORD ATL)
    H007: "C000000001", // UK
    H005: "C000000001", // HK
  };

  const suffix = customerAccountSuffix[dataAreaId] || "C000000001"; // Default fallback
  return `${dataAreaId}-${suffix}`;
}

/**
 * Derive customer account directly from dataAreaId.
 * This prevents warehouse-name defaults from leaking wrong account dimensions.
 */
export function getOrderingCustomerAccountNumberByDataAreaId(dataAreaId: string): string {
  const normalized = (dataAreaId || "").toUpperCase();
  const profile = getWarehouseConfigForDataAreaId(normalized);
  if (profile.orderingCustomerAccountNumber) {
    return profile.orderingCustomerAccountNumber;
  }
  return deriveCustomerAccountNumber(normalized);
}

/**
 * Build default ledger dimension display value with an explicit dataAreaId.
 */
export function toDefaultLedgerDimensionDisplayValueByDataArea(
  warehouseName: string,
  dataAreaId: string
): string {
  const profile = isKnownWarehouseName(warehouseName)
    ? getWarehouseConfig(warehouseName)
    : getWarehouseConfigForDataAreaId(dataAreaId);
  const orderingCustomerAccountNumber = getOrderingCustomerAccountNumberByDataAreaId(dataAreaId);
  return `~${profile.dimensionValue}~${profile.project}~~${orderingCustomerAccountNumber}`;
}

/**
 * Generate default ledger dimension display value
 * Format: ~{dimensionValue}~{project}~~{customerAccountNumber}
 * Ported from spock-store toDefaultLedgerDimensionDisplayValue
 */
export function toDefaultLedgerDimensionDisplayValue(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  const { dimensionValue, project } = config;
  const orderingCustomerAccountNumber = getOrderingCustomerAccountNumber(warehouseName);
  return `~${dimensionValue}~${project}~~${orderingCustomerAccountNumber}`;
}

// ============================================================================
// Warehouse Routing Logic
// ============================================================================

/**
 * Determine warehouse name from a shipping country code.
 *
 * Priority:
 *   1. COUNTRY_ROUTING_OVERRIDES env var (per-deploy tweaks)
 *   2. warehouse-config.json countryRouting table
 *   3. defaultWarehouse fallback
 */
export function determineWarehouse(shippingCountryCode: string): WarehouseName {
  const code = (shippingCountryCode || "").toUpperCase();

  // 1. Env-var overrides (e.g. per-environment / A-B routing)
  const overrides = getCountryOverrides();
  if (overrides[code]) {
    console.log(`[Routing] Country ${code} → ${overrides[code]} (env override)`);
    return overrides[code];
  }

  // 2. Config-driven routing table
  const routingTable = warehouseConfig.countryRouting as Record<string, string>;
  const fromConfig = routingTable[code];
  if (fromConfig && fromConfig in warehouseConfig.warehouses) {
    return fromConfig as WarehouseName;
  }

  // 3. Default
  console.warn(
    `[Routing] No routing rule for country "${code}" — falling back to default warehouse "${warehouseConfig.defaultWarehouse}"`
  );
  return warehouseConfig.defaultWarehouse as WarehouseName;
}

/**
 * Prefer the Hub-persisted fulfillment warehouse (when it matches `warehouse-config.json`)
 * so refund service SKUs and return warehouses stay aligned with GPS vs STORD profiles that
 * share the same D365 `dataAreaId` (e.g. U001). Otherwise same as {@link determineWarehouse}.
 */
export function resolveRefundFulfillmentWarehouse(
  shippingCountryCode: string | null | undefined,
  hubWarehouseLabel: string | null | undefined
): WarehouseName {
  const hub = typeof hubWarehouseLabel === "string" ? hubWarehouseLabel.trim() : "";
  if (hub && isKnownWarehouseName(hub)) {
    return hub;
  }
  return determineWarehouse(shippingCountryCode || "US");
}

/**
 * Resolve full routing from a country code in one call.
 * Returns warehouseName + dataAreaId together.
 *
 * Use this everywhere instead of calling determineWarehouse + getDataAreaId separately.
 */
export function resolveCountryRouting(countryCode: string): RoutingResult {
  const warehouseName = determineWarehouse(countryCode);
  const warehouseCfg = getWarehouseConfig(warehouseName);
  const code = (countryCode || "").toUpperCase();
  const overrides = getCountryOverrides();

  const source: RoutingResult["source"] = overrides[code]
    ? "country_override"
    : (warehouseConfig.countryRouting as Record<string, string>)[code]
      ? "country_config"
      : "default";

  return {
    warehouseName,
    dataAreaId: warehouseCfg.dataAreaId,
    countryCode: code,
    source,
  };
}

/**
 * Returns the complete routing table as currently resolved —
 * merges the config JSON with any active env-var overrides.
 * Used by the /api/routing debug endpoint.
 */
export function getActiveRoutingTable(): {
  countryRouting: Record<string, { warehouse: WarehouseName; dataAreaId: string; source: string }>;
  warehouses: Record<string, { dataAreaId: string; gpsCode?: string }>;
  overrides: Record<string, WarehouseName>;
} {
  const overrides = getCountryOverrides();
  const configTable = warehouseConfig.countryRouting as Record<string, string>;

  const allCountries = new Set([...Object.keys(configTable), ...Object.keys(overrides)]);
  const countryRouting: Record<
    string,
    { warehouse: WarehouseName; dataAreaId: string; source: string }
  > = {};

  for (const country of allCountries) {
    const result = resolveCountryRouting(country);
    countryRouting[country] = {
      warehouse: result.warehouseName,
      dataAreaId: result.dataAreaId,
      source: result.source,
    };
  }

  const warehouses: Record<string, { dataAreaId: string; gpsCode?: string }> = {};
  for (const [name, cfg] of Object.entries(warehouseConfig.warehouses)) {
    warehouses[name] = {
      dataAreaId: (cfg as WarehouseConfig).dataAreaId,
      gpsCode: (cfg as WarehouseConfig).gpsCode,
    };
  }

  return { countryRouting, warehouses, overrides };
}

/**
 * Distinct `dataAreaId` values from warehouse-config (e.g. U001, H007).
 * Used for D365 `SalesOrderHeadersV3` lookup by `THK_ShopifyReference` when the
 * legal entity that created the order is not known (e.g. refunds).
 */
export function getConfiguredWarehouseDataAreaIds(): string[] {
  const ids = new Set<string>();
  for (const w of Object.values(warehouseConfig.warehouses) as WarehouseConfig[]) {
    if (w.dataAreaId) {
      ids.add(w.dataAreaId.toUpperCase());
    }
  }
  return [...ids];
}

/**
 * Preferred order of data areas to try for Shopify reference lookup: country-routed
 * warehouse first (matches `process-shopify-order` when location routing is not used),
 * then remaining configured areas.
 */
export function getSalesOrderLookupDataAreaCandidates(shippingCountryCode: string): string[] {
  const routed = resolveCountryRouting(shippingCountryCode || "US").dataAreaId.toUpperCase();
  const rest = getConfiguredWarehouseDataAreaIds().filter((id) => id !== routed);
  return [routed, ...rest].filter(Boolean);
}

/**
 * Get GPS warehouse code for API calls
 */
export function getGpsWarehouseCode(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  if (!config.gpsCode) {
    throw new Error(`Warehouse ${warehouseName} is not a GPS warehouse`);
  }
  return config.gpsCode;
}

/**
 * Get GPS logistics channel for API calls
 */
export function getGpsLogisticsChannel(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  if (!config.logisticsChannel) {
    throw new Error(`Warehouse ${warehouseName} does not have a logistics channel`);
  }
  return config.logisticsChannel;
}

// ============================================================================
// Service SKU Helpers
// ============================================================================

function resolveServiceSkuConfig(
  warehouseName: string,
  dataAreaIdOverride?: string
): WarehouseConfig {
  const normalizedDataAreaId = (dataAreaIdOverride || "").toUpperCase();

  // If a routed dataAreaId is provided, prefer a profile aligned to it.
  // Keep warehouse-specific profile when it already matches the routed area
  // (e.g. STORD ATL U001 keeps STORD-specific shipping/refund/tax SKUs).
  if (normalizedDataAreaId) {
    try {
      const byWarehouse = getWarehouseConfig(warehouseName);
      if ((byWarehouse.dataAreaId || "").toUpperCase() === normalizedDataAreaId) {
        return applyServiceSkus(byWarehouse, normalizedDataAreaId);
      }
    } catch {
      // Ignore unknown warehouse names and fall back to dataArea profile below.
    }
    return applyServiceSkus(
      getWarehouseConfigForDataAreaId(normalizedDataAreaId),
      normalizedDataAreaId
    );
  }

  const profile = getWarehouseConfig(warehouseName);
  return applyServiceSkus(profile, (profile.dataAreaId || "").toUpperCase());
}

export type ServiceSkuProfile = "UAT" | "PROD";

export interface ServiceSkuSet {
  tax: string;
  refund: string;
  shipping: string;
}

/**
 * D365 service SKUs (tax / shipping / refund) per environment and legal entity (dataAreaId).
 *
 * SINGLE SOURCE OF TRUTH — selected by `SHOPIFY_STORE_MODE` (test → UAT, production → PROD).
 * These are static D365 item numbers; change them here (code review + tests), never via env vars.
 *
 * NOTE: in UAT, `IM8-SER-000003` is the *shipping* item, so the UAT refund item is `IM8-SER-000005`.
 *       in PROD, the refund item is `IM8-SER-000003` and shipping is `IM8-SER-000002`.
 */
export const SERVICE_SKUS_BY_PROFILE: Record<
  ServiceSkuProfile,
  Record<string, ServiceSkuSet>
> = {
  UAT: {
    U001: { tax: "IM8-SER-000004", refund: "IM8-SER-000005", shipping: "IM8-SER-000003" },
    H007: { tax: "IM8-SER-000001", refund: "IM8-SER-000005", shipping: "IM8-SER-000003" },
  },
  PROD: {
    U001: { tax: "IM8-SER-000001", refund: "IM8-SER-000003", shipping: "IM8-SER-000002" },
    H007: { tax: "IM8-SER-000001", refund: "IM8-SER-000003", shipping: "IM8-SER-000002" },
  },
};

/** UAT when `SHOPIFY_STORE_MODE=test`, PROD when `production` (NODE_ENV fallback otherwise). */
export function getServiceSkuEnvProfile(): ServiceSkuProfile {
  const storeMode = String(process.env.SHOPIFY_STORE_MODE || "").trim().toLowerCase();
  if (storeMode === "production") return "PROD";
  if (storeMode === "test") return "UAT";
  return process.env.NODE_ENV === "production" ? "PROD" : "UAT";
}

/** Active profile's service SKUs keyed by dataAreaId (U001 / H007). */
export function getServiceSkuOverridesByDataArea(): Record<string, ServiceSkuSet> {
  return { ...SERVICE_SKUS_BY_PROFILE[getServiceSkuEnvProfile()] };
}

/** Service SKUs for a single dataAreaId in the active profile, or null when unknown. */
function getServiceSkuSet(dataAreaId: string): ServiceSkuSet | null {
  const profile = getServiceSkuEnvProfile();
  return SERVICE_SKUS_BY_PROFILE[profile][(dataAreaId || "").toUpperCase()] ?? null;
}

/** Overlay the active profile's service SKUs onto a warehouse config for the given dataAreaId. */
function applyServiceSkus(config: WarehouseConfig, dataAreaId: string): WarehouseConfig {
  const skus = getServiceSkuSet(dataAreaId);
  if (!skus) return config;
  return {
    ...config,
    item: { tax: skus.tax, refund: skus.refund, shipping: skus.shipping },
  };
}

/**
 * Get shipping SKU for warehouse or routed dataArea profile.
 */
export function getShippingSku(warehouseName: string, dataAreaIdOverride?: string): string {
  const config = resolveServiceSkuConfig(warehouseName, dataAreaIdOverride);
  return config.item.shipping;
}

/**
 * Get tax SKU for warehouse or routed dataArea profile.
 */
export function getTaxSku(warehouseName: string, dataAreaIdOverride?: string): string {
  const config = resolveServiceSkuConfig(warehouseName, dataAreaIdOverride);
  return config.item.tax;
}

export type RefundSkuResolution = {
  refundSku: string;
  dataAreaId: string;
  warehouseName: string;
  /** profile_constant = from SERVICE_SKUS_BY_PROFILE; warehouse_config = unknown dataArea fallback. */
  source: "profile_constant" | "warehouse_config";
  /** UAT or PROD, selected by SHOPIFY_STORE_MODE. */
  profile: ServiceSkuProfile;
  /** Refund SKU on the warehouse-config.json profile (before applying the active SKU set). */
  warehouseConfigRefund: string;
};

function resolveBaseWarehouseConfigForServiceSku(
  warehouseName: string,
  normalizedDataAreaId: string
): WarehouseConfig {
  if (normalizedDataAreaId) {
    try {
      const byWarehouse = getWarehouseConfig(warehouseName);
      if ((byWarehouse.dataAreaId || "").toUpperCase() === normalizedDataAreaId) {
        return byWarehouse;
      }
    } catch {
      // Unknown warehouse label — fall back to dataArea profile.
    }
    return getWarehouseConfigForDataAreaId(normalizedDataAreaId);
  }
  return getWarehouseConfig(warehouseName);
}

/**
 * Resolve refund SKU with audit metadata.
 *
 * Refund SKU comes from {@link SERVICE_SKUS_BY_PROFILE} for the routed dataAreaId and the
 * active profile (SHOPIFY_STORE_MODE). Falls back to warehouse-config `item.refund` only when
 * the dataAreaId is not in the profile map.
 */
export function resolveRefundSkuAudit(
  warehouseName: string,
  dataAreaIdOverride?: string
): RefundSkuResolution {
  const normalizedDataAreaId = (dataAreaIdOverride || "")
    .toUpperCase()
    .trim();
  const baseConfig = resolveBaseWarehouseConfigForServiceSku(
    warehouseName,
    normalizedDataAreaId || (getWarehouseConfig(warehouseName).dataAreaId || "").toUpperCase()
  );
  const dataAreaId =
    normalizedDataAreaId || (baseConfig.dataAreaId || "").toUpperCase().trim();

  const profile = getServiceSkuEnvProfile();
  const skus = getServiceSkuSet(dataAreaId);
  const finalConfig = applyServiceSkus(baseConfig, dataAreaId);

  return {
    refundSku: finalConfig.item.refund,
    dataAreaId,
    warehouseName,
    source: skus ? "profile_constant" : "warehouse_config",
    profile,
    warehouseConfigRefund: baseConfig.item.refund,
  };
}

/**
 * Get refund SKU for warehouse or routed dataArea profile.
 */
export function getRefundSku(warehouseName: string, dataAreaIdOverride?: string): string {
  return resolveRefundSkuAudit(warehouseName, dataAreaIdOverride).refundSku;
}

// ============================================================================
// Fulfilment Helpers
// ============================================================================

/**
 * Get fulfilment configuration for warehouse
 */
export function getFulfilmentConfig(warehouseName: string) {
  const config = getWarehouseConfig(warehouseName);
  return config.fulfilment;
}

/**
 * Get return configuration for warehouse
 */
export function getReturnConfig(warehouseName: string) {
  const config = getWarehouseConfig(warehouseName);
  return config.return;
}

/**
 * Check if warehouse should skip D365 fulfilment notification
 * GPS UK orders skip notification to avoid double notification from D365
 */
export function shouldSkipFulfilmentNotification(warehouseName: string): boolean {
  return isGpsUkWarehouse(warehouseName);
}

/**
 * Check valid warehouse
 */
export function isValidGpsWarehouse(warehouseName: string): boolean {
  const validWarehouses = ["GPS Warehouse", "GPS UK Warehouse"];
  return validWarehouses.includes(warehouseName);
}

/**
 * Extract GPS fulfillment data
 */
export function extractGpsFulfilmentData(payload: IGpsIndividualFulfilment) {
  const { orderData, warehouse } = payload;

  return {
    // Identifiers
    gpsOrderNo: orderData.outboundOrderNo,
    shopifyOrderName: orderData.platformOrderNo,
    d365SalesOrderNumber: orderData.referOrderNo,

    // Tracking
    trackingNumber: orderData.logisticsTrackNo,
    trackingNumbers: orderData.logisticsTrackNos,
    carrier: orderData.logisticsCarrier,

    // Status
    status: orderData.status,
    isFulfilled: orderData.status === 3,

    // Timestamps
    shippedAt: orderData.outboundTime,

    // Warehouse
    warehouse,
    warehouseCode: orderData.whCode,

    // Items
    items: orderData.productList.map((item) => ({
      sku: item.sku,
      quantity: item.realQuantity,
    })),
  };
}

// ============================================================================
// Config Validation (runs once at module load)
// ============================================================================

function validateWarehouseConfig(): void {
  const errors: string[] = [];
  const warehouseNames = Object.keys(warehouseConfig.warehouses);

  for (const [name, wh] of Object.entries(warehouseConfig.warehouses)) {
    const w = wh as Partial<WarehouseConfig>;
    if (!w.name) errors.push(`${name}: missing name`);
    if (!w.dataAreaId) errors.push(`${name}: missing dataAreaId`);
    if (!w.item?.tax) errors.push(`${name}: missing item.tax`);
    if (!w.item?.refund) errors.push(`${name}: missing item.refund`);
    if (!w.item?.shipping) errors.push(`${name}: missing item.shipping`);
    if (!w.fulfilment?.shippingSiteId) errors.push(`${name}: missing fulfilment.shippingSiteId`);
    if (!w.fulfilment?.shippingWarehouseId)
      errors.push(`${name}: missing fulfilment.shippingWarehouseId`);
  }

  for (const [country, warehouse] of Object.entries(warehouseConfig.countryRouting)) {
    if (!warehouseNames.includes(warehouse)) {
      errors.push(`countryRouting.${country} references unknown warehouse: ${warehouse}`);
    }
  }

  for (const gw of warehouseConfig.gpsWarehouses) {
    if (!warehouseNames.includes(gw)) {
      errors.push(`gpsWarehouses references unknown warehouse: ${gw}`);
    }
  }

  for (const sw of warehouseConfig.stordWarehouses) {
    if (!warehouseNames.includes(sw)) {
      errors.push(`stordWarehouses references unknown warehouse: ${sw}`);
    }
  }

  if (!warehouseNames.includes(warehouseConfig.defaultWarehouse)) {
    errors.push(
      `defaultWarehouse references unknown warehouse: ${warehouseConfig.defaultWarehouse}`
    );
  }

  if (errors.length > 0) {
    console.warn("[warehouse-config] Validation warnings:", errors.join("; "));
  }
}

validateWarehouseConfig();
