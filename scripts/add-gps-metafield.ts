/**
 * Script to add GPS metafield to an existing order
 * Usage: npx ts-node scripts/add-gps-metafield.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local explicitly
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const SHOPIFY_SHOP_DOMAIN = (
  process.env.SHOPIFY_IM8_SHOP_DOMAIN || "im8health.myshopify.com"
).replace("https://", "");
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_IM8_ACCESS_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

console.log("Loaded config:");
console.log("  SHOPIFY_SHOP_DOMAIN:", SHOPIFY_SHOP_DOMAIN);
console.log(
  "  SHOPIFY_ACCESS_TOKEN:",
  SHOPIFY_ACCESS_TOKEN ? `${SHOPIFY_ACCESS_TOKEN.substring(0, 10)}...` : "NOT SET"
);
console.log("");

// Order details - UPDATE THESE
const ORDER_NAME = "IM8-14959"; // Shopify order name
const GPS_ORDER_ID = "OBS2262601270SA"; // GPS order ID from the successful GPS creation
const WAREHOUSE = "GPS UK Warehouse";
const D365_ORDER_NUMBER = "U001-SO-210054";

async function getOrderByName(orderName: string) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=${encodeURIComponent(orderName)}&status=any`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.orders?.[0];
}

async function addGpsMetafield(orderId: number) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/metafields.json`;

  const metafieldData = {
    gpsOrderId: GPS_ORDER_ID,
    warehouse: WAREHOUSE,
    d365OrderNumber: D365_ORDER_NUMBER,
    createdAt: new Date().toISOString(),
  };

  const body = {
    metafield: {
      namespace: "battle_bus",
      key: "gps_order",
      value: JSON.stringify(metafieldData),
      type: "json",
    },
  };

  console.log("Adding metafield to order:", orderId);
  console.log("Metafield data:", JSON.stringify(metafieldData, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to add metafield: ${response.status} - ${error}`);
  }

  const data = await response.json();
  console.log("✅ Metafield added successfully!");
  console.log("Response:", JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Adding GPS Metafield to Order");
  console.log("=".repeat(60));
  console.log("");
  console.log(`Order Name: ${ORDER_NAME}`);
  console.log(`GPS Order ID: ${GPS_ORDER_ID}`);
  console.log(`Warehouse: ${WAREHOUSE}`);
  console.log(`D365 Order: ${D365_ORDER_NUMBER}`);
  console.log(`Shop Domain: ${SHOPIFY_SHOP_DOMAIN}`);
  console.log("");

  // Step 1: Find the order
  console.log(`Looking up order ${ORDER_NAME}...`);
  const order = await getOrderByName(ORDER_NAME);

  if (!order) {
    console.error(`❌ Order ${ORDER_NAME} not found!`);
    process.exit(1);
  }

  console.log(`✅ Found order: ID ${order.id}, Name: ${order.name}`);
  console.log(`   Fulfillment Status: ${order.fulfillment_status || "unfulfilled"}`);
  console.log("");

  // Step 2: Add the metafield
  await addGpsMetafield(order.id);

  console.log("");
  console.log("=".repeat(60));
  console.log("Done! The cron job should now pick up this order.");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
