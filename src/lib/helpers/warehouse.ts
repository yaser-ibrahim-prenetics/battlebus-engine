// ============================================================================
// WAREHOUSE ROUTING HELPERS
// ============================================================================
// Ported from spock-store src/component/warehouse.ts

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
 * Determine warehouse based on shipping country
 * Simplified routing logic - can be extended based on business rules
 */
export function determineWarehouse(shippingCountryCode: string): WarehouseName {
  // UK/EU orders go to GPS UK
  const ukEuCountries = [
    "GB",
    "UK",
    "IE",
    "FR",
    "DE",
    "IT",
    "ES",
    "NL",
    "BE",
    "AT",
    "PT",
    "PL",
    "SE",
    "DK",
    "FI",
    "NO",
    "CH",
    "CZ",
    "GR",
    "HU",
    "RO",
  ];

  if (ukEuCountries.includes(shippingCountryCode?.toUpperCase())) {
    return "GPS UK Warehouse";
  }

  // HK/Asia orders could go to HK Warehouse
  const asiaCountries = ["HK", "SG", "MY", "TH", "VN", "PH", "ID", "TW"];
  if (asiaCountries.includes(shippingCountryCode?.toUpperCase())) {
    return "HK Warehouse";
  }

  // Default to US GPS warehouse
  return "GPS Warehouse";
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
 * Get tax SKU for warehouse
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
