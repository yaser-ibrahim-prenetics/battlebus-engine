// ============================================================================
// SHOPIFY API CLIENT
// ============================================================================
// Extracted from spock-store src/component/integration/shopify/restful.ts
// Refactored for stateless execution with Inngest

import crypto from "crypto";
import { config } from "../config";
import { IShopifyFulfillmentOrder, IShopifyOrder } from "../types/shopify";
import { logFlowEvent } from "../services/supabase-flow-logs";

const SHOPIFY_API_VERSION = config.shopify.im8.apiVersion;

/**
 * Get Shopify API headers
 */
function getHeaders(): Record<string, string> {
  return {
    "X-Shopify-Access-Token": config.shopify.im8.accessToken,
    "Content-Type": "application/json",
  };
}

/**
 * Build Shopify API URL
 */
function buildUrl(endpoint: string): string {
  return `https://${config.shopify.im8.shopDomain}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`;
}

/**
 * Resolve latest SKU values by Shopify variant IDs via Admin GraphQL.
 * Returns a map keyed by numeric variant ID (legacyResourceId).
 */
export async function getVariantSkusByVariantIds(
  variantIds: Array<number | string>
): Promise<Record<string, string>> {
  const normalizedIds = Array.from(
    new Set(
      variantIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id))
    )
  );

  if (normalizedIds.length === 0) return {};

  const url = buildUrl(`/graphql.json`);
  const result: Record<string, string> = {};
  const chunkSize = 100;

  for (let i = 0; i < normalizedIds.length; i += chunkSize) {
    const chunk = normalizedIds.slice(i, i + chunkSize);
    const gqlIds = chunk.map((id) => `gid://shopify/ProductVariant/${id}`);
    const response = await fetch(url, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        query: `
          query VariantSkus($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                legacyResourceId
                sku
              }
            }
          }
        `,
        variables: { ids: gqlIds },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch variant SKUs: ${response.status} - ${error}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(
        `Failed to fetch variant SKUs: ${payload.errors
          .map((e: any) => e?.message || "Unknown GraphQL error")
          .join("; ")}`
      );
    }

    const nodes = Array.isArray(payload?.data?.nodes) ? payload.data.nodes : [];
    for (const node of nodes) {
      if (!node) continue;
      const sku = typeof node.sku === "string" ? node.sku.trim() : "";
      if (!sku) continue;
      const legacyId =
        node.legacyResourceId != null ? String(node.legacyResourceId) : "";
      if (legacyId) {
        result[legacyId] = sku;
        continue;
      }
      const gid = typeof node.id === "string" ? node.id : "";
      const fallbackId = gid.split("/").pop() || "";
      if (fallbackId) result[fallbackId] = sku;
    }
  }

  return result;
}

/**
 * Get inventory levels per location for an inventory item
 * Returns location-wise breakdown of inventory
 */
export async function getInventoryLevelsByLocation(inventoryItemId: number): Promise<
  Array<{
    location_id: string;
    location_name: string;
    available: number;
    reserved: number;
    committed: number;
  }>
> {
  const url = buildUrl(`/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get inventory levels: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const inventoryLevels = data.inventory_levels || [];

  // Also fetch location details to get location names
  const locationIds = inventoryLevels.map((level: any) => level.location_id);
  const locationsMap = new Map<string, string>();

  if (locationIds.length > 0) {
    try {
      const locationsUrl = buildUrl(`/locations.json?ids=${locationIds.join(",")}`);
      const locationsResponse = await fetch(locationsUrl, {
        method: "GET",
        headers: getHeaders(),
      });

      if (locationsResponse.ok) {
        const locationsData = await locationsResponse.json();
        const locations = locationsData.locations || [];
        for (const location of locations) {
          locationsMap.set(String(location.id), location.name);
        }
      }
    } catch (error) {
      // If location fetch fails, continue without location names
    }
  }

  return inventoryLevels.map((level: any) => ({
    location_id: String(level.location_id),
    location_name: locationsMap.get(String(level.location_id)) || null,
    available: level.available || 0,
    reserved: 0, // Shopify doesn't provide reserved in inventory_levels endpoint
    committed: 0, // Shopify doesn't provide committed in inventory_levels endpoint
  }));
}

/**
 * Get all locations from Shopify
 * Returns all active locations with their details
 */
export async function getAllLocations(): Promise<
  Array<{
    id: string;
    name: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    zip?: string;
    phone?: string;
    active: boolean;
    fulfillment_service_id?: string;
  }>
> {
  const url = buildUrl(`/locations.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get locations: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const locations = data.locations || [];

  return locations.map((loc: any) => ({
    id: String(loc.id),
    name: loc.name,
    address1: loc.address1 || null,
    address2: loc.address2 || null,
    city: loc.city || null,
    province: loc.province || null,
    country: loc.country || null,
    zip: loc.zip || null,
    phone: loc.phone || null,
    active: loc.active !== false,
    fulfillment_service_id: loc.fulfillment_service_id ? String(loc.fulfillment_service_id) : null,
  }));
}

/**
 * Get Order by ID
 */
export async function getOrder(orderId: string | number): Promise<ShopifyOrder> {
  const startedAt = Date.now();
  const url = buildUrl(`/orders/${orderId}.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    await logFlowEvent({
      level: "error",
      flow: "external_api_call",
      step: "shopify_get_order",
      client: "shopify",
      shopifyOrderId: String(orderId),
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorType: `http_${response.status}`,
      errorMessage: error.slice(0, 500),
      payload: { endpoint: "/orders/:id.json" },
    });
    throw new Error(`Failed to get Shopify order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  await logFlowEvent({
    level: "info",
    flow: "external_api_call",
    step: "shopify_get_order",
    client: "shopify",
    shopifyOrderId: String(orderId),
    shopifyOrderName: data?.order?.name,
    status: "completed",
    durationMs: Date.now() - startedAt,
    payload: { endpoint: "/orders/:id.json", httpStatus: response.status },
  });
  return data.order;
}

/**
 * Get all metafields for a Shopify order.
 * Used as a fallback for legacy GPS metafield keys (e.g. gpsorderid / gpsukorderid).
 */
export async function getOrderMetafields(orderId: string | number): Promise<any[]> {
  const url = buildUrl(`/orders/${orderId}/metafields.json?limit=250`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Shopify order metafields: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return Array.isArray(data?.metafields) ? data.metafields : [];
}

/**
 * Attempt to restore a previously-cancelled Shopify order.
 * Shopify exposes this as "open" in REST.
 */
export async function uncancelOrder(orderId: string | number): Promise<ShopifyOrder> {
  const url = buildUrl(`/orders/${orderId}/open.json`);

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to uncancel Shopify order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.order;
}

/**
 * Get Fulfillment Orders for an Order
 */
export async function getFulfillmentOrders(
  orderId: string | number
): Promise<IShopifyFulfillmentOrder[]> {
  if (config.features.enabledShopifyOrderMock) {
    const mockData = await import("../mocks/shopify/fulfillments.json");
    console.log(`Using mock shopify fulfillment data for order ${orderId}`);
    return mockData.fulfillment_orders;
  }

  const url = buildUrl(`/orders/${orderId}/fulfillment_orders.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get fulfillment orders: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.fulfillment_orders;
}

/**
 * Create a Fulfillment in Shopify
 */
export async function createFulfillment(
  fulfillmentOrderId: string | number,
  trackingInfo: {
    number: string;
    company: string;
    url?: string;
  },
  lineItems?: { id: number; quantity: number }[],
  fulfillmentType?: string,
  platform?: string
): Promise<ShopifyFulfillment> {
  if (config.features.enabledShopifyCreateFulfillmentMock) {
    const mockData = await import("../mocks/shopify/fulfillmentsCreate.json");
    console.log(`Using mock shopify fulfillment data to create order ${fulfillmentOrderId}`);
    return mockData.fulfillment;
  }

  const url = buildUrl("/fulfillments.json");

  // Build fulfillment order entry - only include line items if provided
  // Following spock-store pattern: if line items not specified, Shopify fulfills all items
  const fulfillmentOrderEntry: any = {
    fulfillment_order_id: fulfillmentOrderId,
  };

  // Only include fulfillment_order_line_items if lineItems is provided and not empty
  if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
    fulfillmentOrderEntry.fulfillment_order_line_items = lineItems;
  }

  // Build note with fulfillment metadata
  const noteParts: string[] = [];
  if (fulfillmentType) {
    noteParts.push(`FulfillmentType: ${fulfillmentType}`);
  }
  if (platform) {
    noteParts.push(`Platform: ${platform}`);
  }
  const note = noteParts.length > 0 ? noteParts.join(" | ") : undefined;

  const body: any = {
    fulfillment: {
      line_items_by_fulfillment_order: [fulfillmentOrderEntry],
      tracking_info: {
        number: trackingInfo.number || "",
        company: trackingInfo.company || "Other",
        ...(trackingInfo.url && { url: trackingInfo.url }),
      },
      notify_customer: true,
      ...(note && { note }),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create Shopify fulfillment: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.fulfillment;
}

/**
 * Get Unfulfilled Orders
 * Fetches orders that are not yet fulfilled (unfulfilled or partial)
 * Includes any status (open, closed, etc.) to catch all pending fulfillments
 *
 * Note: Uses created_at_min to include orders from the last 30 days,
 * since the API returns orders in descending order by creation date
 * and older orders may be missed if we only use limit.
 */
export async function getUnfulfilledOrders(
  limit: number = 250,
  daysBack: number = 30
): Promise<ShopifyOrder[]> {
  // Calculate date range - include orders from the last N days
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - daysBack);
  const createdAtMin = minDate.toISOString();

  // Query for unfulfilled orders - don't filter by status to catch all orders needing fulfillment
  // fulfillment_status can be: unfulfilled, partial, fulfilled, restocked
  const url = buildUrl(
    `/orders.json?fulfillment_status=unfulfilled&limit=${limit}&created_at_min=${createdAtMin}`
  );

  console.log(`[Shopify] Fetching unfulfilled orders (limit=${limit}, daysBack=${daysBack})`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get unfulfilled orders: ${response.status} - ${error}`);
  }

  const data = await response.json();
  console.log(`[Shopify] Found ${data.orders?.length || 0} unfulfilled orders`);
  return data.orders;
}

/**
 * Search Orders by Name (e.g., IM8-1001)
 */
export async function searchOrdersByName(orderName: string): Promise<IShopifyOrder[]> {
  if (config.features.enabledShopifyOrderMock) {
    const mockData = await import("../mocks/shopify/orders.json");
    console.log(`Using mock shopify order data for order ${orderName}`);
    return mockData.orders;
  }

  const url = buildUrl(`/orders.json?name=${encodeURIComponent(orderName)}&status=any`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to search orders by name: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.orders;
}

/**
 * Get Order Transactions
 */
export async function getOrderTransactions(
  orderId: string | number
): Promise<ShopifyTransaction[]> {
  const url = buildUrl(`/orders/${orderId}/transactions.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get order transactions: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.transactions;
}

/**
 * Verify Shopify Webhook Signature
 */
export function verifyWebhookSignature(body: string, hmacHeader: string): boolean {
  const hash = crypto
    .createHmac("sha256", config.shopify.im8.webhookSecret)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// ============================================================================
// GPS ORDER TRACKING VIA METAFIELDS (Secure Storage)
// ============================================================================
// Using metafields instead of tags for GPS order IDs because:
// 1. Metafields are not visible in standard Shopify admin UI
// 2. They use a private namespace (battle_bus) that's clearly internal
// 3. Less likely to be accidentally modified by non-technical staff
// 4. Can store structured data (JSON) with type safety

const GPS_METAFIELD_NAMESPACE = "battle_bus";
const GPS_METAFIELD_KEY = "gps_order";

export interface GpsOrderMetafield {
  gpsOrderId: string;
  warehouse: string;
  d365OrderNumber: string;
  createdAt: string;
}

/**
 * Set GPS order metafield on a Shopify order
 * Stores GPS order ID and warehouse info securely
 */
export async function setGpsOrderMetafield(
  orderId: string | number,
  data: GpsOrderMetafield
): Promise<void> {
  const url = buildUrl(`/orders/${orderId}/metafields.json`);

  const body = {
    metafield: {
      namespace: GPS_METAFIELD_NAMESPACE,
      key: GPS_METAFIELD_KEY,
      value: JSON.stringify(data),
      type: "json",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set GPS metafield: ${response.status} - ${error}`);
  }

  console.log(`[Shopify] Set GPS metafield on order ${orderId}: ${data.gpsOrderId}`);
}

/**
 * Get GPS order metafield from a Shopify order
 */
export async function getGpsOrderMetafield(
  orderId: string | number
): Promise<GpsOrderMetafield | null> {
  const url = buildUrl(
    `/orders/${orderId}/metafields.json?namespace=${GPS_METAFIELD_NAMESPACE}&key=${GPS_METAFIELD_KEY}`
  );

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get GPS metafield: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const metafields = data.metafields || [];

  const gpsMetafield = metafields.find(
    (mf: any) => mf.namespace === GPS_METAFIELD_NAMESPACE && mf.key === GPS_METAFIELD_KEY
  );

  if (!gpsMetafield) return null;

  try {
    return JSON.parse(gpsMetafield.value) as GpsOrderMetafield;
  } catch {
    console.warn(`[Shopify] Failed to parse GPS metafield for order ${orderId}`);
    return null;
  }
}

/**
 * Set fulfillment metadata on order (fulfillmentType and platform)
 * Stores as order metafields for tracking
 */
export async function setFulfillmentMetadata(
  orderId: string | number,
  fulfillmentId: string | number,
  fulfillmentType: string,
  platform: string
): Promise<void> {
  const url = buildUrl(`/orders/${orderId}/metafields.json`);

  const metadata = {
    fulfillmentId: fulfillmentId.toString(),
    fulfillmentType,
    platform,
    createdAt: new Date().toISOString(),
  };

  const body = {
    metafield: {
      namespace: GPS_METAFIELD_NAMESPACE,
      key: `fulfillment_${fulfillmentId}`,
      value: JSON.stringify(metadata),
      type: "json",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    console.warn(`[Shopify] Failed to set fulfillment metadata: ${response.status} - ${error}`);
    // Don't throw - this is optional metadata
  } else {
    console.log(
      `[Shopify] Set fulfillment metadata on order ${orderId} for fulfillment ${fulfillmentId}`
    );
  }
}

/**
 * Get unfulfilled orders that have GPS order metafields
 * Returns orders along with their GPS order data
 */
export async function getUnfulfilledGpsOrders(
  limit: number = 250,
  daysBack: number = 30
): Promise<Array<ShopifyOrder & { gpsData: GpsOrderMetafield }>> {
  // Get unfulfilled orders
  const orders = await getUnfulfilledOrders(limit, daysBack);

  console.log(`[Shopify] Checking ${orders.length} orders for GPS metafields...`);

  // Fetch GPS metafields for each order
  const gpsOrders: Array<ShopifyOrder & { gpsData: GpsOrderMetafield }> = [];

  for (const order of orders) {
    try {
      const gpsData = await getGpsOrderMetafield(order.id);
      if (gpsData) {
        console.log(`[Shopify] Found GPS metafield for order ${order.name}: ${gpsData.gpsOrderId}`);
        gpsOrders.push({
          ...order,
          gpsData,
        });
      }
    } catch (error) {
      // Skip orders where we can't fetch metafields
      console.warn(`[Shopify] Failed to get GPS metafield for order ${order.id}: ${error}`);
    }
  }

  console.log(`[Shopify] Found ${gpsOrders.length} orders with GPS metafields`);
  return gpsOrders;
}

/**
 * Get Order Risk
 */
export async function getOrderRisks(orderId: string | number): Promise<ShopifyFraudAnalysis[]> {
  if (!config.features.enabledShopifyRiskCheck) return [];

  if (config.features.enabledShopifyRiskMock) {
    const mockData = await import("../mocks/shopify/risks.json");
    console.log(`Using mock risk data for order ${orderId}`);
    return mockData.risks;
  }

  const url = buildUrl(`/latest/orders/${orderId}/risks.json`);
  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get risk analysis order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.risks;
}

// Types
export interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_refunded?: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  line_items: ShopifyLineItem[];
  shipping_address: ShopifyAddress | null;
  billing_address: ShopifyAddress | null;
  shipping_lines: ShopifyShippingLine[];
  discount_codes: ShopifyDiscountCode[];
  note: string | null;
  tags: string;
  customer: ShopifyCustomer | null;
  refunds: ShopifyRefund[];
  /** Present on many API responses; used for FX / refund rate extraction. */
  transactions?: ShopifyTransaction[];
}

export interface ShopifyLineItem {
  id: number;
  variant_id: number | null;
  title: string;
  quantity: number;
  sku: string;
  variant_title: string | null;
  vendor: string | null;
  fulfillment_service: string;
  product_id: number | null;
  requires_shipping: boolean;
  taxable: boolean;
  gift_card: boolean;
  name: string;
  price: string;
  total_discount: string;
  fulfillment_status: string | null;
  properties: { name: string; value: string }[];
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyAddress {
  first_name: string;
  last_name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone: string | null;
  company: string | null;
  country_code: string;
  province_code: string;
}

export interface ShopifyShippingLine {
  id: number;
  title: string;
  price: string;
  code: string;
  source: string;
  carrier_identifier: string | null;
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyTaxLine {
  title: string;
  price: string;
  rate: number;
}

export interface ShopifyDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  tags: string;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyTransaction[];
}

export interface ShopifyRefundLineItem {
  id: number;
  quantity: number;
  line_item_id: number;
  line_item: ShopifyLineItem;
  subtotal: string;
  total_tax: string;
}

export interface ShopifyTransaction {
  id: number;
  kind: string;
  gateway: string;
  status: string;
  amount: string;
}

export interface ShopifyFulfillmentOrder {
  id: number;
  order_id: number;
  status: string;
  assigned_location_id: number | null;
  assigned_location?: {
    id: number;
    name: string;
    address1: string;
    city: string;
    province: string;
    country: string;
    zip: string;
  };
  delivery_method?: {
    method_type: string;
  };
  line_items: ShopifyFulfillmentOrderLineItem[];
}

export interface ShopifyFulfillmentOrderLineItem {
  id: number;
  shop_id: number;
  fulfillment_order_id: number;
  quantity: number;
  line_item_id: number;
  inventory_item_id: number;
  fulfillable_quantity: number;
  variant_id: number;
}

export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string;
  tracking_company: string;
  tracking_url: string;
}

export interface ShopifyFraudAnalysis {
  id: number;
  order_id: number;
  checkout_id: number | null;
  source: string;
  score: string;
  recommendation: string;
  display: boolean;
  cause_cancel: boolean;
  message: string;
  merchant_message: string;
}
