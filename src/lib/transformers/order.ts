// ============================================================================
// ORDER TRANSFORMERS
// ============================================================================
// Extracted from spock-store src/component/salesorder.ts
// Pure functions for transforming Shopify orders to D365/GPS formats

import { config } from "../config";
import type { ShopifyOrder, ShopifyLineItem, ShopifyAddress } from "../clients/shopify";
import type { D365SalesOrderHeader, D365SalesOrderLine } from "../types/dynamics";
import type { GpsOutboundOrder, GpsOrderItem } from "../types/gps";

// SKU Mapping (simplified - in production, load from config/database)
const SKU_MAPPING: Record<string, string> = {
  // Shopify SKU -> D365 Item Number
  // Add your mappings here
};

/**
 * Transform Shopify Order to D365 Sales Order Header
 */
export function toD365SalesOrderHeader(
  order: ShopifyOrder,
  dataAreaId: string = config.dynamics.dataAreaId
): D365SalesOrderHeader {
  const shippingAddress = order.shipping_address || order.billing_address;

  return {
    dataAreaId,
    CustomerAccountNumber: getCustomerAccountNumber(order),
    InvoiceCustomerAccountNumber: getCustomerAccountNumber(order),
    SalesOrderName: order.name,
    OrderingCustomerAccountNumber: getCustomerAccountNumber(order),
    RequestedShippingDate: formatD365Date(order.created_at),
    RequestedReceiptDate: formatD365Date(order.created_at, 7), // +7 days
    DeliveryAddressName: formatAddressName(shippingAddress),
    DeliveryAddressStreet: formatStreet(shippingAddress),
    DeliveryAddressCity: shippingAddress?.city || "",
    DeliveryAddressState: shippingAddress?.province_code || "",
    DeliveryAddressCountryRegionId: shippingAddress?.country_code || "",
    DeliveryAddressZipCode: shippingAddress?.zip || "",
    DeliveryAddressDescription: formatAddressDescription(shippingAddress),
    SalesOrderOriginCode: "WEB",
    Email: order.email,
    CurrencyCode: order.currency,
    LanguageId: "en-us",
    DeliveryModeCode: getDeliveryModeCode(order),
    SiteId: getSiteId(order),
    WarehouseId: getWarehouseId(order),
    DefaultShippingSiteId: getSiteId(order),
    DefaultShippingWarehouseId: getWarehouseId(order),
    // IM8 Custom Fields
    IM8ShopifyOrderId: String(order.id),
    IM8ShopifyOrderName: order.name,
    IM8ShopifyStore: "im8",
  };
}

/**
 * Transform Shopify Line Item to D365 Sales Order Line
 */
export function toD365SalesOrderLine(
  lineItem: ShopifyLineItem,
  salesOrderNumber: string,
  dataAreaId: string = config.dynamics.dataAreaId
): D365SalesOrderLine {
  const itemNumber = mapSku(lineItem.sku);
  const price = parseFloat(lineItem.price);
  const discount = parseFloat(lineItem.total_discount);

  return {
    dataAreaId,
    SalesOrderNumber: salesOrderNumber,
    ItemNumber: itemNumber,
    SalesQuantity: lineItem.quantity,
    SalesPrice: price,
    LineAmount: price * lineItem.quantity - discount,
    SalesUnitSymbol: "ea",
    RequestedShippingDate: formatD365Date(new Date().toISOString()),
    ShippingSiteId: "IM8",
    ShippingWarehouseId: "GPS",
    LineDescription: lineItem.name,
    LineDiscountAmount: discount,
  };
}

/**
 * Transform Shopify Order to GPS Outbound Order
 */
export function toGpsOutboundOrder(order: ShopifyOrder): GpsOutboundOrder {
  const shippingAddress = order.shipping_address || order.billing_address;

  return {
    orderNumber: order.name,
    orderDate: order.created_at,
    customerCode: getCustomerAccountNumber(order),
    shipToName: formatAddressName(shippingAddress),
    shipToAddress1: shippingAddress?.address1 || "",
    shipToAddress2: shippingAddress?.address2 || undefined,
    shipToCity: shippingAddress?.city || "",
    shipToState: shippingAddress?.province_code || "",
    shipToZip: shippingAddress?.zip || "",
    shipToCountry: shippingAddress?.country_code || "",
    shipToPhone: shippingAddress?.phone || undefined,
    shipToEmail: order.email,
    carrierCode: getCarrierCode(order),
    serviceCode: getServiceCode(order),
    items: order.line_items
      .filter((item) => item.requires_shipping && !item.gift_card)
      .map(toGpsOrderItem),
    shopifyOrderId: String(order.id),
    shopifyOrderName: order.name,
  };
}

/**
 * Transform Shopify Line Item to GPS Order Item
 */
export function toGpsOrderItem(lineItem: ShopifyLineItem): GpsOrderItem {
  return {
    sku: lineItem.sku,
    quantity: lineItem.quantity,
    description: lineItem.name,
    unitPrice: parseFloat(lineItem.price),
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function mapSku(shopifySku: string): string {
  return SKU_MAPPING[shopifySku] || shopifySku;
}

function getCustomerAccountNumber(order: ShopifyOrder): string {
  // Default customer account for web orders
  return "WEBIM8";
}

function formatD365Date(isoDate: string, addDays: number = 0): string {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + addDays);
  return date.toISOString().split("T")[0];
}

function formatAddressName(address: ShopifyAddress | null): string {
  if (!address) return "";
  return `${address.first_name} ${address.last_name}`.trim();
}

function formatStreet(address: ShopifyAddress | null): string {
  if (!address) return "";
  return [address.address1, address.address2].filter(Boolean).join(", ");
}

function formatAddressDescription(address: ShopifyAddress | null): string {
  if (!address) return "";
  return `${formatAddressName(address)}, ${formatStreet(address)}, ${address.city}`;
}

function getDeliveryModeCode(order: ShopifyOrder): string {
  const shippingLine = order.shipping_lines[0];
  if (!shippingLine) return "STANDARD";

  const code = shippingLine.code?.toLowerCase() || "";
  if (code.includes("express") || code.includes("priority")) return "EXPRESS";
  if (code.includes("overnight")) return "OVERNIGHT";
  return "STANDARD";
}

function getSiteId(order: ShopifyOrder): string {
  // IM8 default site
  return "IM8";
}

function getWarehouseId(order: ShopifyOrder): string {
  // Determine warehouse based on shipping destination or other logic
  // For IM8, default to GPS warehouse
  return "GPS";
}

function getCarrierCode(order: ShopifyOrder): string {
  const shippingLine = order.shipping_lines[0];
  if (!shippingLine) return "USPS";

  const title = shippingLine.title?.toLowerCase() || "";
  if (title.includes("ups")) return "UPS";
  if (title.includes("fedex")) return "FEDEX";
  if (title.includes("dhl")) return "DHL";
  return "USPS";
}

function getServiceCode(order: ShopifyOrder): string {
  const shippingLine = order.shipping_lines[0];
  if (!shippingLine) return "GROUND";

  const code = shippingLine.code?.toLowerCase() || "";
  if (code.includes("express") || code.includes("2day")) return "2DAY";
  if (code.includes("overnight") || code.includes("next")) return "OVERNIGHT";
  if (code.includes("priority")) return "PRIORITY";
  return "GROUND";
}

/**
 * Calculate total prepayment amount from order
 */
export function calculatePrepaymentAmount(order: ShopifyOrder): number {
  return parseFloat(order.total_price);
}

/**
 * Check if order should be sent to GPS warehouse
 */
export function shouldSendToGps(order: ShopifyOrder): boolean {
  // IM8 orders go to GPS by default
  // Add logic to check for specific conditions
  return order.line_items.some(
    (item) => item.requires_shipping && !item.gift_card
  );
}

/**
 * Check if order should be sent to STORD warehouse
 */
export function shouldSendToStord(order: ShopifyOrder): boolean {
  // Add logic for STORD routing
  // For now, return false as GPS is primary
  return false;
}
