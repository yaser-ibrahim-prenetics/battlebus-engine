import { config } from "../../config";
import type { IShopifyFulfillmentOrder, IShopifyOrder } from "../../types/shopify";
import { logFlowEvent } from "../../services/flow-logs";
import { buildShopifyUrl, getShopifyHeaders } from "./request";
import {
  maskShopifyAccessToken,
  resolveShopifyAdminCredentials,
  shopifyAdminApiCredentialSource,
} from "./credentials";
import type { ShopifyFulfillment, ShopifyOrder, ShopifyTransaction } from "./types";

/**
 * Get Order by ID
 * @param shopDomainForCredentials - optional `*.myshopify.com` host to pick PROD vs TEST API token
 */
export async function getOrder(
  orderId: string | number,
  shopDomainForCredentials?: string | null
): Promise<ShopifyOrder> {
  const startedAt = Date.now();
  const c = resolveShopifyAdminCredentials(shopDomainForCredentials);
  if (!c.accessToken?.trim()) {
    const src = shopifyAdminApiCredentialSource(shopDomainForCredentials);
    throw new Error(
      `Shopify Admin token is missing for getOrder (${orderId}). ${src} — set SHOPIFY_PROD_ACCESS_TOKEN / SHOPIFY_TEST_ACCESS_TOKEN in env.`
    );
  }
  const url = `https://${c.shopDomain}/admin/api/${c.apiVersion}/orders/${orderId}.json`;
  const requestDebug = {
    shopDomainHintFromEvent: shopDomainForCredentials ?? null,
    credentialSource: shopifyAdminApiCredentialSource(shopDomainForCredentials),
    requestUrl: url,
    resolvedShopDomain: c.shopDomain,
    apiVersion: c.apiVersion,
    accessTokenPreview: maskShopifyAccessToken(c.accessToken),
    storeMode: config.shopify.storeMode,
  };
  console.log(`[Shopify] getOrder ${orderId}:`, JSON.stringify(requestDebug));

  const headers = {
    "X-Shopify-Access-Token": c.accessToken,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    const hint401 =
      response.status === 401
        ? " Shopify returned 401: the Admin API access token is not accepted for this shop (revoked, wrong app, incorrect Secret Manager value, or using a test token as production). Regenerate the token in Shopify Admin → Settings → Apps → [your custom app] → API credentials, then update SHOPIFY_PROD_ACCESS_TOKEN / SHOPIFY_TEST_* to match that shop. If credentials are correct, ensure event.data.shopifyStore is set on Inngest replays."
        : "";
    const hint403 =
      response.status === 403 && /read_orders|merchant approval|scope/i.test(error)
        ? " Add Admin API scope read_orders (and related order scopes you need) on the custom app: Settings → Apps and sales channels → Develop apps → [app] → Configuration → Admin API scopes → enable read_orders → Save → Install app / update install so the merchant approves new scopes → Reveal Admin API access token again if Shopify prompts, then update SHOPIFY_*_ACCESS_TOKEN in Secret Manager and deploy a new revision."
        : "";
    console.error(`[Shopify] getOrder failed ${orderId}:`, {
      ...requestDebug,
      httpStatus: response.status,
      bodyPreview: error.slice(0, 300),
    });
    logFlowEvent({
      level: "error",
      flow: "external_api_call",
      step: "shopify_get_order",
      client: "shopify",
      shopifyOrderId: String(orderId),
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorType: `http_${response.status}`,
      errorMessage: error.slice(0, 500),
      payload: { endpoint: "/orders/:id.json", shopifyRequest: requestDebug },
    });
    throw new Error(
      `Failed to get Shopify order: ${response.status} - ${error}${hint401}${hint403}`
    );
  }

  const data = await response.json();
  logFlowEvent({
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
export async function getOrderMetafields(
  orderId: string | number,
  shopDomainForCredentials?: string | null
): Promise<any[]> {
  const credentials = resolveShopifyAdminCredentials(shopDomainForCredentials);
  const url = `https://${credentials.shopDomain}/admin/api/${credentials.apiVersion}/orders/${orderId}/metafields.json?limit=250`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": credentials.accessToken,
      "Content-Type": "application/json",
    },
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
  const url = buildShopifyUrl(`/orders/${orderId}/open.json`);

  const response = await fetch(url, {
    method: "POST",
    headers: getShopifyHeaders(),
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
    const mockData = await import("../../mocks/shopify/fulfillments.json");
    console.log(`Using mock shopify fulfillment data for order ${orderId}`);
    return mockData.fulfillment_orders;
  }

  const url = buildShopifyUrl(`/orders/${orderId}/fulfillment_orders.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
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
  platform?: string,
  options?: { notifyCustomer?: boolean }
): Promise<ShopifyFulfillment> {
  if (config.features.enabledShopifyCreateFulfillmentMock) {
    const mockData = await import("../../mocks/shopify/fulfillmentsCreate.json");
    console.log(`Using mock shopify fulfillment data to create order ${fulfillmentOrderId}`);
    return mockData.fulfillment;
  }

  const url = buildShopifyUrl("/fulfillments.json");

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
      notify_customer: options?.notifyCustomer !== false,
      ...(note && { note }),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getShopifyHeaders(),
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
  const url = buildShopifyUrl(
    `/orders.json?fulfillment_status=unfulfilled&limit=${limit}&created_at_min=${createdAtMin}`
  );

  console.log(`[Shopify] Fetching unfulfilled orders (limit=${limit}, daysBack=${daysBack})`);

  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
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
 * @param shopDomainForCredentials - optional `*.myshopify.com` host to pick PROD vs TEST API token
 */
export async function searchOrdersByName(
  orderName: string,
  shopDomainForCredentials?: string | null
): Promise<IShopifyOrder[]> {
  if (config.features.enabledShopifyOrderMock) {
    const mockData = await import("../../mocks/shopify/orders.json");
    console.log(`Using mock shopify order data for order ${orderName}`);
    return mockData.orders;
  }

  const c = resolveShopifyAdminCredentials(shopDomainForCredentials);
  const url = `https://${c.shopDomain}/admin/api/${c.apiVersion}/orders.json?name=${encodeURIComponent(orderName)}&status=any`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": c.accessToken,
      "Content-Type": "application/json",
    },
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
  orderId: string | number,
  shopDomainForCredentials?: string | null
): Promise<ShopifyTransaction[]> {
  const c = resolveShopifyAdminCredentials(shopDomainForCredentials);
  const url = `https://${c.shopDomain}/admin/api/${c.apiVersion}/orders/${orderId}/transactions.json`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": c.accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get order transactions: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.transactions;
}

/**
 * Order events timeline (REST) — used to detect refunds initiated by Loop Returns.
 */
export interface ShopifyOrderEvent {
  id: number;
  verb?: string | null;
  path?: string | null;
  author?: string | null;
  subject?: string | null;
  subject_id?: number | null;
}

export async function getOrderEvents(
  orderId: string | number
): Promise<{ events: ShopifyOrderEvent[] }> {
  const url = buildShopifyUrl(`/orders/${orderId}/events.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get order events: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const events = Array.isArray(data?.events) ? (data.events as ShopifyOrderEvent[]) : [];
  return { events };
}

