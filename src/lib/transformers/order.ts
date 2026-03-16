// ============================================================================
// ORDER TRANSFORMERS
// ============================================================================
// Ported from spock-store src/component/salesorder.ts
// Pure functions for transforming Shopify orders to D365/GPS formats

/**
 * Get line items from order, with defensive check for missing/invalid data
 * Returns empty array if line_items is missing or not an array
 */
function getLineItems(order: ShopifyOrderPayload): ShopifyLineItem[] {
  return Array.isArray(order.line_items) ? order.line_items : [];
}

import { config } from "../config";
import type { ShopifyOrderPayload, ShopifyLineItem, ShopifyAddress } from "../../inngest/events";
import type {
  D365SalesOrderHeaderV3Request,
  D365SalesOrderLineRequest,
  D365SalesOrderHeadersV3Address,
} from "../types/dynamics";
import { toSalesOrderHeadersV3Address, toGpsOrderAddress, formatAddressName } from "./address";
import {
  mapShopifySkuToDynamics,
  createShopifyToDynamicsLineTransformer,
  mergeGpsDuplicateSkuLines,
  filterServiceSkus,
  filterDummySkus,
  explodeBundleLines,
} from "./sku";
import {
  getWarehouseConfig,
  getWarehouseConfigForDataAreaId,
  determineWarehouse,
  toDefaultLedgerDimensionDisplayValue,
  toDefaultLedgerDimensionDisplayValueByDataArea,
  getGpsWarehouseCode,
  getGpsLogisticsChannel,
  isGpsUkWarehouse,
  isGpsWarehouse,
  getShippingSku,
  getTaxSku,
  getOrderingCustomerAccountNumber,
  getOrderingCustomerAccountNumberByDataAreaId,
} from "../helpers/warehouse";
import type { GpsOrderData, GpsProductItem } from "../clients/gps";

// GPS Order Type constants
const GpsOrderType = {
  PRODUCT_OUTBOUND: 1,
  SAMPLE_OUTBOUND: 2,
  RETURN_OUTBOUND: 3,
} as const;

// ============================================================================
// D365 TRANSFORMERS
// ============================================================================

/**
 * Transform Shopify Order to D365 Sales Order Header V3 Request
 * Uses THK custom fields as per spock-store
 */
export function toD365SalesOrderHeaderV3(
  order: ShopifyOrderPayload,
  warehouseName?: string,
  dataAreaIdOverride?: string
): D365SalesOrderHeaderV3Request {
  const warehouse =
    warehouseName ||
    determineWarehouse(
      order.shipping_address?.country_code || order.billing_address?.country_code || "US"
    );
  const effectiveDataAreaId = (dataAreaIdOverride || "").toUpperCase();
  const warehouseConfig = effectiveDataAreaId
    ? getWarehouseConfigForDataAreaId(effectiveDataAreaId)
    : getWarehouseConfig(warehouse);
  const orderingCustomerAccountNumber = effectiveDataAreaId
    ? getOrderingCustomerAccountNumberByDataAreaId(effectiveDataAreaId)
    : getOrderingCustomerAccountNumber(warehouse);
  const defaultLedgerDimensionDisplayValue = effectiveDataAreaId
    ? toDefaultLedgerDimensionDisplayValueByDataArea(warehouse, effectiveDataAreaId)
    : toDefaultLedgerDimensionDisplayValue(warehouse);

  const shippingAddress = order.shipping_address || order.billing_address;
  const billingAddress = order.billing_address || order.shipping_address;

  return {
    customerId: String(order.customer?.id || ""),
    orderId: String(order.id),
    dataAreaId: effectiveDataAreaId || warehouseConfig.dataAreaId,
    orderingCustomerAccountNumber,
    defaultLedgerDimensionDisplayValue,
    customerOrderReference: order.name,
    email: order.email,
    name: order.customer
      ? `${order.customer.first_name} ${order.customer.last_name}`.trim()
      : formatAddressName(shippingAddress),
    shopifyReference: order.name,
    shippingAddress: shippingAddress ? toSalesOrderHeadersV3Address(shippingAddress) : undefined,
    billingAddress: billingAddress ? toSalesOrderHeadersV3Address(billingAddress) : undefined,
    comment: buildOrderComment(order),
    currency: order.currency,
    // Skip fulfilment notification for GPS UK to avoid double notification
    skipFulfillmentNotification: isGpsUkWarehouse(warehouse) ? "Yes" : undefined,
  };
}

/**
 * Build order comment for D365
 * Includes gift card info, associated orders, etc.
 */
function buildOrderComment(order: ShopifyOrderPayload): string {
  const parts: string[] = [];

  // Add gift card purchase info
  const lineItems = getLineItems(order);
  const giftCardItems = lineItems.filter((item) => item.gift_card === true);
  if (giftCardItems.length > 0) {
    for (const gc of giftCardItems) {
      parts.push(`Gift Card Purchase: ${gc.sku || gc.title || "Unknown"} x ${gc.quantity}`);
    }
  }

  // Add gift card discount codes applied to order
  if (order.discount_codes?.length > 0) {
    const giftCardDiscounts = order.discount_codes.filter(
      (d: any) => d.type === "gift_card"
    );
    for (const gcd of giftCardDiscounts) {
      parts.push(`Gift Card Applied: ${gcd.code} - $${parseFloat(gcd.amount || "0").toFixed(2)}`);
    }
  }

  // Add discount codes (non-gift-card)
  if (order.discount_codes?.length > 0) {
    const nonGiftCardDiscounts = order.discount_codes.filter(
      (d: any) => d.type !== "gift_card"
    );
    if (nonGiftCardDiscounts.length > 0) {
      parts.push(`Discount Codes: ${nonGiftCardDiscounts.map((d) => d.code).join(", ")}`);
    }
  }

  // Add order note
  if (order.note) {
    parts.push(`Note: ${order.note}`);
  }

  // Add tags
  if (order.tags) {
    parts.push(`Tags: ${order.tags}`);
  }

  return parts.join("\n");
}

/**
 * Transform Shopify Line Item to D365 Sales Order Line Request
 */
export function toD365SalesOrderLine(
  lineItem: ShopifyLineItem,
  salesOrderNumber: string,
  dataAreaId: string,
  currency: string,
  discountCodes?: string[],
  countryCode?: string
): D365SalesOrderLineRequest {
  const itemNumber = mapShopifySkuToDynamics(lineItem.sku);
  const price = parseFloat(lineItem.price);
  const totalDiscount = parseFloat(lineItem.total_discount) || 0;
  const discountPerUnit = lineItem.quantity > 0 ? totalDiscount / lineItem.quantity : 0;

  return {
    salesOrderNumber,
    dataAreaId,
    itemNumber,
    quantity: lineItem.quantity,
    price,
    ...(discountPerUnit > 0 ? { discount: discountPerUnit } : {}),
    currency,
    discountCode: discountCodes,
    ...(countryCode ? { countryCode } : {}),
  };
}

/**
 * Create all D365 sales order lines from Shopify order
 * Includes shipping and tax lines
 */
export function toD365SalesOrderLines(
  order: ShopifyOrderPayload,
  salesOrderNumber: string,
  warehouseName: string,
  includeShippingAndTax: boolean = true,
  dataAreaIdOverride?: string
): D365SalesOrderLineRequest[] {
  const dataAreaId = (dataAreaIdOverride || "").toUpperCase()
    ? (dataAreaIdOverride || "").toUpperCase()
    : getWarehouseConfig(warehouseName).dataAreaId;
  const currency = order.currency || "USD";
  const discountCodes = order.discount_codes?.map((d) => d.code);
  const skuTransformer = createShopifyToDynamicsLineTransformer();

  // Extract country code from shipping or billing address
  const countryCode =
    order.shipping_address?.country_code || order.billing_address?.country_code || undefined;

  const lines: D365SalesOrderLineRequest[] = [];

  // Add product lines
  const lineItems = getLineItems(order);

  if (!Array.isArray(order.line_items)) {
    console.warn(
      "[Transformers] order.line_items is missing or not an array – skipping product lines. " +
        "This usually means a test payload is incomplete."
    );
  }

  for (const item of lineItems) {
    if (item.gift_card) continue;

    const line = toD365SalesOrderLine(
      item,
      salesOrderNumber,
      dataAreaId,
      currency,
      discountCodes,
      countryCode
    );
    const transformedLine = skuTransformer(line);
    lines.push(transformedLine);
  }

  const explodedLines = explodeBundleLines(lines);
  lines.length = 0;
  lines.push(...explodedLines);

  // Add shipping line
  // NOTE: Temporarily disabled - IM8-SER-* SKUs don't exist in D365 sandbox yet
  // TODO: Re-enable once service SKUs are created in D365
  if (includeShippingAndTax && false) {
    const shippingCost = calculateShippingCost(order);
    if (shippingCost > 0) {
      lines.push({
        salesOrderNumber,
        dataAreaId,
        itemNumber: getShippingSku(warehouseName),
        quantity: 1,
        price: shippingCost,
        currency,
      });
    }

    // Add tax line
    const taxAmount = calculateTaxAmount(order);
    if (taxAmount > 0) {
      lines.push({
        salesOrderNumber,
        dataAreaId,
        itemNumber: getTaxSku(warehouseName),
        quantity: 1,
        price: taxAmount,
        currency,
      });
    }
  }

  return lines;
}

// ============================================================================
// GPS TRANSFORMERS
// ============================================================================

/**
 * Transform Shopify Order to GPS Outbound Order
 */
export function toGpsOutboundOrder(
  order: ShopifyOrderPayload,
  d365SalesOrderNumber: string,
  warehouseName: string = "GPS Warehouse"
): GpsOrderData {
  const shippingAddress = order.shipping_address || order.billing_address;

  if (!shippingAddress) {
    throw new Error(`No shipping address for order ${order.name}`);
  }

  // Get GPS-specific config
  const whCode = getGpsWarehouseCode(warehouseName);
  const logisticsChannel = getGpsLogisticsChannel(warehouseName);

  // Transform address
  const gpsAddress = toGpsOrderAddress({
    ...shippingAddress,
    email: order.email,
  });

  // Transform line items (filter and merge duplicates)
  const lineItems = getLineItems(order);

  if (!Array.isArray(order.line_items)) {
    console.warn(
      `[Transformers] order.line_items is missing or not an array for GPS order ${order.name} – using empty product list`
    );
  }

  const skuTransformer = createShopifyToDynamicsLineTransformer();
  const productLines = lineItems
    .filter((item) => item.requires_shipping && !item.gift_card)
    .map((item) => ({
      itemNumber: item.sku,
      quantity: item.quantity,
    }))
    .map(skuTransformer);

  // Explode bundles, filter service/dummy SKUs, and merge duplicates
  const explodedProductLines = explodeBundleLines(productLines);
  const filteredLines = filterDummySkus(filterServiceSkus(explodedProductLines));
  const productList = mergeGpsDuplicateSkuLines(filteredLines);

  return {
    platformOrderNo: order.name,
    thirdOrderNo: d365SalesOrderNumber,
    whCode,
    subOrderType: GpsOrderType.PRODUCT_OUTBOUND,
    logisticsChannel,
    ...gpsAddress,
    productList,
  };
}

// ============================================================================
// CALCULATION HELPERS
// ============================================================================

/**
 * Calculate total shipping cost from order
 */
export function calculateShippingCost(order: ShopifyOrderPayload): number {
  if (!order.shipping_lines?.length) return 0;

  return order.shipping_lines.reduce((total, line) => {
    const price = parseFloat(line.price) || 0;
    // Shipping line discounts are handled separately in Shopify
    return total + price;
  }, 0);
}

/**
 * Calculate total tax amount from order
 */
export function calculateTaxAmount(order: ShopifyOrderPayload): number {
  return parseFloat(order.total_tax) || 0;
}

/**
 * Calculate total prepayment amount from order
 */
export function calculatePrepaymentAmount(order: ShopifyOrderPayload): number {
  return parseFloat(order.total_price) || 0;
}

/**
 * Calculate total order cost from lines
 */
export function calculateOrderCost(
  lines: Array<{ price: number; discount?: number; quantity: number }>
): number {
  return lines.reduce((total, line) => {
    const lineTotal = (line.price - (line.discount || 0)) * line.quantity;
    return total + lineTotal;
  }, 0);
}

// ============================================================================
// ROUTING HELPERS
// ============================================================================

/**
 * Check if order should be sent to GPS warehouse
 * Only GPS warehouses need syncing - Stord has its own Shopify app
 */
export function shouldSendToGps(order: ShopifyOrderPayload, warehouseName?: string): boolean {
  // If warehouse is explicitly provided, check if it's a GPS warehouse
  // Stord orders are already syncing via Shopify app, so skip GPS sync for Stord
  if (warehouseName) {
    return isGpsWarehouse(warehouseName);
  }

  // Fallback: Check fulfillment location to see if it's GPS (not Stord)
  // Try to get fulfillment location from fulfillment orders
  // If location is Stord, return false (Stord has its own Shopify app)
  const lineItems = getLineItems(order);

  if (!Array.isArray(order.line_items)) {
    console.warn(
      "[Transformers] order.line_items is missing or not an array – treating as no-GPS order. " +
        "This usually means a test payload is incomplete."
    );
    return false;
  }

  // Check if order has shippable items
  const hasShippableItems = lineItems.some((item) => item.requires_shipping && !item.gift_card);

  if (!hasShippableItems) {
    return false;
  }

  // Default: assume GPS if we can't determine otherwise
  // This will be refined by warehouseName check in process-shopify-order
  return true;
}

/**
 * Check if order should be sent to STORD warehouse
 */
export function shouldSendToStord(order: ShopifyOrderPayload): boolean {
  // STORD routing logic - currently not used for IM8
  return false;
}

/**
 * Check if order is a test order
 */
export function isTestOrder(order: ShopifyOrderPayload): boolean {
  const testTags = ["testing", "load-testing", "test"];
  const tags = (order.tags || "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim());
  return testTags.some((tag) => tags.includes(tag));
}

export function isOrderTaggedWith(order: Pick<ShopifyOrderPayload, "tags">, tagToCheck: string) {
  if (!order.tags) return false;
  const normalizedTag = tagToCheck.toLowerCase();
  return order.tags.split(",").some((tag) => tag.trim().toLowerCase().startsWith(normalizedTag));
}

// ============================================================================
// LEGACY EXPORTS (for backwards compatibility)
// ============================================================================

export { toSalesOrderHeadersV3Address, toGpsOrderAddress, formatAddressName } from "./address";

export {
  mapShopifySkuToDynamics,
  mergeGpsDuplicateSkuLines as mergeGPSDuplicateSKUOrderLines,
} from "./sku";

export {
  determineWarehouse,
  resolveCountryRouting,
  getActiveRoutingTable,
  getWarehouseConfig,
  toDefaultLedgerDimensionDisplayValue,
} from "../helpers/warehouse";
