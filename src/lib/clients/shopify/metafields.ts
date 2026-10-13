import { resolveShopifyAdminCredentials } from "./credentials";
import { getUnfulfilledOrders } from "./orders";
import { buildShopifyUrl, getShopifyHeaders } from "./request";
import type { ShopifyOrder } from "./types";

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
  const url = buildShopifyUrl(`/orders/${orderId}/metafields.json`);

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
    headers: getShopifyHeaders(),
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
 * @param shopDomainForCredentials - optional `*.myshopify.com` host to pick PROD vs TEST API token
 */
export async function getGpsOrderMetafield(
  orderId: string | number,
  shopDomainForCredentials?: string | null
): Promise<GpsOrderMetafield | null> {
  const c = resolveShopifyAdminCredentials(shopDomainForCredentials);
  const url = `https://${c.shopDomain}/admin/api/${c.apiVersion}/orders/${orderId}/metafields.json?namespace=${GPS_METAFIELD_NAMESPACE}&key=${GPS_METAFIELD_KEY}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": c.accessToken,
      "Content-Type": "application/json",
    },
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
  const url = buildShopifyUrl(`/orders/${orderId}/metafields.json`);

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
    headers: getShopifyHeaders(),
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

