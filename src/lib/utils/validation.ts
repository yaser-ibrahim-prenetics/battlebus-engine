// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
// Order validation functions ported from spock-store

import { config } from "@/lib/config";
import type { ShopifyOrderPayload, ShopifyFulfillment } from "../../inngest/events";

// ============================================================================
// ORDER VALIDATION
// ============================================================================

/**
 * Check if order is a test order (before live date or has testing tags)
 * Ported from spock-store isTestOrder
 */
export function isTestOrder(order: Pick<ShopifyOrderPayload, "created_at" | "tags" | "name">): boolean {
  const liveDate = new Date(config.orders.liveDateTime);
  const orderDate = new Date(order.created_at);

  if (orderDate < liveDate) {
    return true;
  }

  const tags = (order.tags || "").toLowerCase().split(",").map((t) => t.trim());
  return config.orders.testTags.some((testTag) => tags.includes(testTag.toLowerCase()));
}

/**
 * Check if order is tagged as high-risk
 */
export function isHighRiskOrder(order: Pick<ShopifyOrderPayload, "tags">): boolean {
  const tags = (order.tags || "").toLowerCase().split(",").map((t) => t.trim());
  return tags.includes(config.orders.highRiskTag.toLowerCase());
}

/**
 * Check if order has only dummy/test SKUs
 */
export function hasOnlyDummySkus(
  order: Pick<ShopifyOrderPayload, "line_items">
): boolean {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.length === 0) return false;

  return lineItems.every((item) => {
    const sku = (item.sku || "").toUpperCase();
    return config.orders.dummySkuPatterns.some((pattern) =>
      sku.includes(pattern.toUpperCase())
    );
  });
}

/**
 * Filter out dummy SKUs from line items
 */
export function filterDummySkus<T extends { sku: string }>(items: T[]): T[] {
  return items.filter((item) => {
    const sku = (item.sku || "").toUpperCase();
    return !config.orders.dummySkuPatterns.some((pattern) =>
      sku.includes(pattern.toUpperCase())
    );
  });
}

/**
 * Validate order before processing
 * Returns validation result with skip reason if order should be skipped
 */
export function validateOrderForProcessing(
  order: ShopifyOrderPayload
): { valid: boolean; skip: boolean; reason?: string } {
  // Skip test orders
  if (config.features.skipTestOrders && isTestOrder(order)) {
    return { valid: true, skip: true, reason: "Test order" };
  }

  // Skip high-risk orders (with warning)
  if (config.features.skipHighRiskOrders && isHighRiskOrder(order)) {
    return { valid: true, skip: true, reason: "High-risk order" };
  }

  // Error on dummy-only orders
  if (hasOnlyDummySkus(order)) {
    return { valid: false, skip: false, reason: "Order has only dummy SKUs" };
  }

  return { valid: true, skip: false };
}

// ============================================================================
// FULFILLMENT VALIDATION
// ============================================================================

/**
 * Check if fulfillment is a dummy/refund fulfillment
 */
export function isDummyFulfillment(fulfillment: ShopifyFulfillment): boolean {
  const hasRealItems = fulfillment.line_items.some((item) => {
    const sku = item.sku || "";
    return (
      sku.length > 0 &&
      !sku.startsWith("ADJUSTMENT") &&
      !sku.startsWith("SHIPPING") &&
      !item.price.startsWith("-")
    );
  });

  return !hasRealItems;
}

/**
 * Validate order payload has required fields
 */
export function validateOrderPayload(order: ShopifyOrderPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!order.id) errors.push("Order ID is required");
  if (!order.name) errors.push("Order name is required");
  if (!order.email) errors.push("Order email is required");

  return { valid: errors.length === 0, errors };
}

/**
 * Check if order can be cancelled
 */
export function canCancelOrder(order: ShopifyOrderPayload): {
  canCancel: boolean;
  reason?: string;
} {
  if (order.fulfillment_status === "fulfilled") {
    return { canCancel: false, reason: "Order is already fulfilled" };
  }

  if (order.cancelled_at) {
    return { canCancel: false, reason: "Order is already cancelled" };
  }

  return { canCancel: true };
}

// ============================================================================
// LOCATION-BASED ROUTING
// ============================================================================

type FulfillmentLocation = "gps" | "gpsUk" | "stord" | "hkWarehouse" | "unknown";

/**
 * Determine fulfillment location from Shopify location_id
 */
export function getFulfillmentLocation(locationId: string | number): FulfillmentLocation {
  const locId = String(locationId);
  const locations = config.shopify.im8.locations;

  if (locations.gps && locId === locations.gps) return "gps";
  if (locations.gpsUk && locId === locations.gpsUk) return "gpsUk";
  if (locations.stord && locId === locations.stord) return "stord";
  if (locations.hkWarehouse && locId === locations.hkWarehouse) return "hkWarehouse";

  return "unknown";
}

/**
 * Check if fulfillment is from GPS (US or UK)
 */
export function isGpsFulfillment(locationId: string | number): boolean {
  const location = getFulfillmentLocation(locationId);
  return location === "gps" || location === "gpsUk";
}

/**
 * Check if fulfillment is from STORD
 */
export function isStordFulfillment(locationId: string | number): boolean {
  return getFulfillmentLocation(locationId) === "stord";
}

/**
 * Determine GPS warehouse name from location_id
 */
export function getGpsWarehouseFromLocation(
  locationId: string | number
): "GPS Warehouse" | "GPS UK Warehouse" | null {
  const location = getFulfillmentLocation(locationId);

  if (location === "gps") return "GPS Warehouse";
  if (location === "gpsUk") return "GPS UK Warehouse";

  return null;
}

/**
 * Get data area ID based on fulfillment location
 */
export function getDataAreaIdFromLocation(locationId: string | number): string {
  const location = getFulfillmentLocation(locationId);

  switch (location) {
    case "gpsUk":
      return "H007"; // UK data area
    case "gps":
    case "stord":
    default:
      return "U001"; // US data area
  }
}
