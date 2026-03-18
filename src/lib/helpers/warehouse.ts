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
 * - U001 (US): U001-C000000006
 * - H007 (UK): H007-C000000001
 * - H005 (HK): H005-C000000001
 */
function deriveCustomerAccountNumber(dataAreaId: string): string {
  // Map data area to customer account suffix
  const customerAccountSuffix: Record<string, string> = {
    U001: "C000000006", // US
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
  return deriveCustomerAccountNumber((dataAreaId || "").toUpperCase());
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

/**
 * Get shipping SKU for warehouse
 */
export function getShippingSku(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  return config.item.shipping;
}

/**
 * Get tax SKU for warehouse.
 */
export function getTaxSku(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  return config.item.tax;
}

/**
 * Get refund SKU for warehouse
 */
export function getRefundSku(warehouseName: string): string {
  const config = getWarehouseConfig(warehouseName);
  return config.item.refund;
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
    if (!w.fulfilment?.shippingWarehouseId) errors.push(`${name}: missing fulfilment.shippingWarehouseId`);
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
    errors.push(`defaultWarehouse references unknown warehouse: ${warehouseConfig.defaultWarehouse}`);
  }

  if (errors.length > 0) {
    console.warn("[warehouse-config] Validation warnings:", errors.join("; "));
  }
}

validateWarehouseConfig();
