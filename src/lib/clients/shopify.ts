// ============================================================================
// SHOPIFY API CLIENT
// ============================================================================
// Extracted from spock-store src/component/integration/shopify/restful.ts
// Refactored for stateless execution with Inngest

import crypto from "crypto";
import { config } from "../config";
import { IShopifyFulfillmentOrder, IShopifyOrder } from "../types/shopify";

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
 * Get Order by ID
 */
export async function getOrder(orderId: string | number): Promise<ShopifyOrder> {
  const url = buildUrl(`/orders/${orderId}.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Shopify order: ${response.status} - ${error}`);
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
    const mockData = await import('../mocks/shopify/fulfillments.json');
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
  lineItems?: { id: number; quantity: number }[]
): Promise<ShopifyFulfillment> {
  if (config.features.enabledShopifyCreateFulfillmentMock) {
    const mockData = await import('../mocks/shopify/fulfillmentsCreate.json');
    console.log(`Using mock shopify fulfillment data to create order ${fulfillmentOrderId}`);
    return mockData.fulfillment;
  }

  const url = buildUrl("/fulfillments.json");

  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fulfillmentOrderId,
          fulfillment_order_line_items: lineItems,
        },
      ],
      tracking_info: {
        number: trackingInfo.number,
        company: trackingInfo.company,
        url: trackingInfo.url,
      },
      notify_customer: true,
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
 */
export async function getUnfulfilledOrders(
  limit: number = 50
): Promise<ShopifyOrder[]> {
  const url = buildUrl(
    `/orders.json?status=open&fulfillment_status=unfulfilled&limit=${limit}`
  );

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to get unfulfilled orders: ${response.status} - ${error}`
    );
  }

  const data = await response.json();
  return data.orders;
}

/**
 * Search Orders by Name (e.g., IM8-1001)
 */
export async function searchOrdersByName(
  orderName: string,
): Promise<IShopifyOrder[]> {
  if (config.features.enabledShopifyOrderMock) {
    const mockData = await import('../mocks/shopify/orders.json');
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
    throw new Error(
      `Failed to search orders by name: ${response.status} - ${error}`
    );
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
export function verifyWebhookSignature(
  body: string,
  hmacHeader: string
): boolean {
  const hash = crypto
    .createHmac("sha256", config.shopify.im8.webhookSecret)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

/**
 * Get Order Risk
 */
export async function getOrderRisks(
  orderId: string | number,
): Promise<ShopifyFraudAnalysis[]> {
  if (!config.features.enabledShopifyRiskCheck) return [];

  if (config.features.enabledShopifyRiskMock) {
    const mockData = await import('../mocks/shopify/risks.json');
    console.log(`Using mock risk data for order ${orderId}`);
    return mockData.risks;
  }

  const url = buildUrl(`/orders/${orderId}/risks.json`);
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
