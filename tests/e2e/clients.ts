/**
 * Real API client wrappers for E2E tests.
 *
 * These call actual Shopify, D365, and GPS APIs.
 * Requires env vars:
 *   SHOPIFY_IM8_SHOP_DOMAIN, SHOPIFY_IM8_ACCESS_TOKEN
 *   D365_BASE_URL, D365_CLIENT_ID, D365_CLIENT_SECRET, D365_TENANT_ID
 *   GPS_API_KEY, GPS_API_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { config } from "@/lib/config";

// ─── Token cache for D365 ───────────────────────────────────────────────────
let d365Token: { accessToken: string; expiresAt: number } | null = null;

async function getD365Token(): Promise<string> {
  if (d365Token && Date.now() < d365Token.expiresAt - 60_000) {
    return d365Token.accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.dynamics.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.dynamics.clientId,
    client_secret: config.dynamics.clientSecret,
    scope: config.dynamics.scope,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    throw new Error(`D365 auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  d365Token = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return d365Token.accessToken;
}

// ─── Shopify Admin REST ─────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2024-07";

function shopifyUrl(path: string): string {
  return `https://${config.shopify.im8.shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

function shopifyHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": config.shopify.im8.accessToken,
  };
}

export const shopifyE2e = {
  async getOrder(orderId: string | number) {
    const res = await fetch(shopifyUrl(`/orders/${orderId}.json`), {
      headers: shopifyHeaders(),
    });
    if (!res.ok) throw new Error(`Shopify getOrder ${orderId}: ${res.status}`);
    const data = await res.json();
    return data.order;
  },

  async getOrderMetafields(orderId: string | number) {
    const res = await fetch(shopifyUrl(`/orders/${orderId}/metafields.json`), {
      headers: shopifyHeaders(),
    });
    if (!res.ok) throw new Error(`Shopify getOrderMetafields ${orderId}: ${res.status}`);
    const data = await res.json();
    return data.metafields || [];
  },

  async cancelOrder(orderId: string | number) {
    const res = await fetch(shopifyUrl(`/orders/${orderId}/cancel.json`), {
      method: "POST",
      headers: shopifyHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify cancelOrder ${orderId}: ${res.status} - ${text}`);
    }
    return (await res.json()).order;
  },

  async uncancelOrder(orderId: string | number) {
    const res = await fetch(
      `https://${config.shopify.im8.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/cancel.json`,
      {
        method: "DELETE",
        headers: shopifyHeaders(),
      }
    );
    return res.ok;
  },

  async getOrderTransactions(orderId: string | number) {
    const res = await fetch(shopifyUrl(`/orders/${orderId}/transactions.json`), {
      headers: shopifyHeaders(),
    });
    if (!res.ok) throw new Error(`Shopify getTransactions ${orderId}: ${res.status}`);
    const data = await res.json();
    return data.transactions || [];
  },

  async createTestOrder(params: {
    lineItems: Array<{ variant_id: number; quantity: number }>;
    tags?: string;
    shippingAddress?: Record<string, string>;
    email?: string;
  }) {
    const payload = {
      order: {
        line_items: params.lineItems,
        tags: params.tags || "testing,e2e-test",
        financial_status: "paid",
        send_receipt: false,
        send_fulfillment_receipt: false,
        ...(params.email ? { email: params.email } : {}),
        ...(params.shippingAddress ? { shipping_address: params.shippingAddress } : {}),
      },
    };

    const res = await fetch(shopifyUrl("/orders.json"), {
      method: "POST",
      headers: shopifyHeaders(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify createTestOrder: ${res.status} - ${text}`);
    }

    const data = await res.json();
    return data.order;
  },

  async closeOrder(orderId: string | number) {
    const res = await fetch(shopifyUrl(`/orders/${orderId}/close.json`), {
      method: "POST",
      headers: shopifyHeaders(),
    });
    return res.ok;
  },
};

// ─── D365 API ───────────────────────────────────────────────────────────────

function d365Url(path: string, dataAreaId?: string): string {
  const base = config.dynamics.baseUrl;
  const area = dataAreaId || config.dynamics.dataAreaId;
  return `${base}/data/${path}?cross-company=true&$filter=dataAreaId eq '${area}'`;
}

async function d365Headers(): Promise<Record<string, string>> {
  const token = await getD365Token();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
  };
}

export const d365E2e = {
  async getSalesOrderByReference(
    shopifyReference: string,
    dataAreaId?: string
  ): Promise<any | null> {
    const area = dataAreaId || config.dynamics.dataAreaId;
    const url =
      `${config.dynamics.baseUrl}/data/SalesOrderHeadersV2?cross-company=true` +
      `&$filter=dataAreaId eq '${area}' and THK_ShopifyReference eq '${shopifyReference}'`;

    const headers = await d365Headers();
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`D365 lookup ${shopifyReference}: ${res.status}`);
    const data = await res.json();
    return data.value?.[0] || null;
  },

  async getSalesOrderLines(
    salesOrderNumber: string,
    dataAreaId?: string
  ): Promise<any[]> {
    const area = dataAreaId || config.dynamics.dataAreaId;
    const url =
      `${config.dynamics.baseUrl}/data/SalesOrderLines?cross-company=true` +
      `&$filter=dataAreaId eq '${area}' and SalesOrderNumber eq '${salesOrderNumber}'`;

    const headers = await d365Headers();
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`D365 getLines ${salesOrderNumber}: ${res.status}`);
    const data = await res.json();
    return data.value || [];
  },

  async deleteSalesOrder(
    salesOrderNumber: string,
    dataAreaId?: string
  ): Promise<boolean> {
    const area = dataAreaId || config.dynamics.dataAreaId;
    const url =
      `${config.dynamics.baseUrl}/data/SalesOrderHeadersV2(dataAreaId='${area}',SalesOrderNumber='${salesOrderNumber}')`;

    const headers = await d365Headers();
    const res = await fetch(url, { method: "DELETE", headers });
    return res.ok || res.status === 404;
  },
};

// ─── GPS OMS API ────────────────────────────────────────────────────────────

function getGpsCredentials(warehouse: "GPS Warehouse" | "GPS UK Warehouse") {
  if (warehouse === "GPS UK Warehouse") {
    return {
      baseUrl: config.gpsUk.baseUrl,
      apiKey: config.gpsUk.apiKey,
      apiSecret: config.gpsUk.apiSecret,
    };
  }
  return {
    baseUrl: config.gps.baseUrl,
    apiKey: config.gps.apiKey,
    apiSecret: config.gps.apiSecret,
  };
}

function generateGpsAuthCode(apiKey: string, apiSecret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const crypto = require("crypto");
  const sign = crypto
    .createHmac("md5", apiSecret)
    .update(`${apiKey}${timestamp}`)
    .digest("hex");
  return `${apiKey},${sign},${timestamp}`;
}

export const gpsE2e = {
  async getOrderStatus(
    orderNumbers: string[],
    warehouse: "GPS Warehouse" | "GPS UK Warehouse" = "GPS Warehouse"
  ) {
    const { baseUrl, apiKey, apiSecret } = getGpsCredentials(warehouse);
    const authCode = generateGpsAuthCode(apiKey, apiSecret);

    const res = await fetch(`${baseUrl}/open/api/oms/outbound/getOutboundOrdersDetails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authCode,
      },
      body: JSON.stringify({
        orderIds: orderNumbers,
      }),
    });

    if (!res.ok) throw new Error(`GPS getOrderStatus: ${res.status}`);
    return res.json();
  },

  async cancelOrder(
    orderNumber: string,
    warehouse: "GPS Warehouse" | "GPS UK Warehouse" = "GPS Warehouse"
  ) {
    const { baseUrl, apiKey, apiSecret } = getGpsCredentials(warehouse);
    const authCode = generateGpsAuthCode(apiKey, apiSecret);

    const res = await fetch(`${baseUrl}/open/api/oms/outbound/cancelOutboundOrder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authCode,
      },
      body: JSON.stringify({
        orderNo: orderNumber,
      }),
    });

    if (!res.ok) throw new Error(`GPS cancelOrder: ${res.status}`);
    return res.json();
  },
};

// ─── Supabase ───────────────────────────────────────────────────────────────

export const supabaseE2e = {
  async getOrder(shopifyOrderId: string): Promise<any | null> {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const res = await fetch(
      `${url}/rest/v1/orders?shopify_order_id=eq.${shopifyOrderId}&select=*`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );

    if (!res.ok) return null;
    const orders = await res.json();
    return orders?.[0] || null;
  },

  async pollForStatus(
    shopifyOrderId: string,
    expectedStatus: string,
    timeoutMs = 90_000,
    pollMs = 3_000
  ): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const order = await this.getOrder(shopifyOrderId);
      if (order?.status === expectedStatus) return order;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `Timeout: order ${shopifyOrderId} did not reach "${expectedStatus}" within ${timeoutMs}ms`
    );
  },
};
