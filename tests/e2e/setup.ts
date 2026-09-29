import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";

const REQUIRED_ENV_VARS = [
  "SHOPIFY_IM8_SHOP_DOMAIN",
  "SHOPIFY_IM8_ACCESS_TOKEN",
  "D365_BASE_URL",
  "D365_CLIENT_ID",
  "D365_CLIENT_SECRET",
  "D365_TENANT_ID",
];

export function validateE2eEnv(): { valid: boolean; missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  const hasDatabase = !!(
    process.env.DATABASE_URL ||
    (process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME && process.env.DB_NAME && process.env.DB_USER)
  );
  if (!hasDatabase) {
    missing.push("DATABASE_URL or CLOUD_SQL_INSTANCE_CONNECTION_NAME+DB_NAME+DB_USER");
  }
  return { valid: missing.length === 0, missing };
}

export async function createTestShopifyOrder(overrides?: {
  tags?: string;
  lineItems?: Array<{ variant_id: number; quantity: number }>;
}): Promise<{ orderId: string; orderName: string }> {
  const shopDomain = config.shopify.im8.shopDomain;
  const accessToken = config.shopify.im8.accessToken;

  const orderPayload = {
    order: {
      line_items: overrides?.lineItems || [{ variant_id: 44001, quantity: 1 }],
      tags: overrides?.tags || "testing,e2e-test",
      financial_status: "paid",
      send_receipt: false,
      send_fulfillment_receipt: false,
    },
  };

  const response = await fetch(`https://${shopDomain}/admin/api/2024-07/orders.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(orderPayload),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test order: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return {
    orderId: String(data.order.id),
    orderName: data.order.name,
  };
}

export async function pollDatabaseForOrder(
  shopifyOrderId: string,
  expectedStatus: string,
  timeoutMs = 60000,
  pollIntervalMs = 3000
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await queryDatabase<Record<string, unknown>>(
        `SELECT * FROM public.orders WHERE shopify_order_id = $1 LIMIT 1`,
        [shopifyOrderId]
      );
      const order = result.rows[0];
      if (order?.status === expectedStatus) {
        return order;
      }
    } catch {
      // continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for order ${shopifyOrderId} to reach status "${expectedStatus}" after ${timeoutMs}ms`
  );
}

export async function cancelTestShopifyOrder(orderId: string): Promise<void> {
  const shopDomain = config.shopify.im8.shopDomain;
  const accessToken = config.shopify.im8.accessToken;

  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-07/orders/${orderId}/cancel.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    }
  );

  if (!response.ok) {
    console.warn(`Failed to cancel test order ${orderId}: ${response.status}`);
  }
}

export async function closeTestShopifyOrder(orderId: string): Promise<void> {
  const shopDomain = config.shopify.im8.shopDomain;
  const accessToken = config.shopify.im8.accessToken;

  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-07/orders/${orderId}/close.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    }
  );

  if (!response.ok) {
    console.warn(`Failed to close test order ${orderId}: ${response.status}`);
  }
}
