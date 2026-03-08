/**
 * Register Shopify Webhooks for Battle Bus
 * Run with: npx tsx scripts/register-shopify-webhooks.ts
 *
 * This script registers all required webhooks pointing to your Vercel deployment.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_IM8_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_IM8_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

// Your Vercel deployment URL
const DEPLOYMENT_URL = "https://battle-bus.vercel.app";

// Webhooks to register
const WEBHOOKS_TO_REGISTER = [
  {
    topic: "orders/create",
    address: `${DEPLOYMENT_URL}/api/webhooks/shopify`,
    format: "json",
  },
  {
    topic: "orders/updated",
    address: `${DEPLOYMENT_URL}/api/webhooks/shopify`,
    format: "json",
  },
  {
    topic: "orders/cancelled",
    address: `${DEPLOYMENT_URL}/api/webhooks/shopify`,
    format: "json",
  },
  {
    topic: "orders/fulfilled",
    address: `${DEPLOYMENT_URL}/api/webhooks/shopify`,
    format: "json",
  },
  {
    topic: "refunds/create",
    address: `${DEPLOYMENT_URL}/api/webhooks/shopify`,
    format: "json",
  },
];

console.log("=".repeat(60));
console.log("Shopify Webhook Registration");
console.log("=".repeat(60));
console.log(`\nDeployment URL: ${DEPLOYMENT_URL}`);
console.log(`Shop Domain: ${SHOPIFY_SHOP_DOMAIN}`);

async function getExistingWebhooks(): Promise<any[]> {
  const shopDomain = SHOPIFY_SHOP_DOMAIN!.replace("https://", "").replace("http://", "");
  const apiUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;

  const response = await fetch(`${apiUrl}/webhooks.json`, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN!,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get webhooks: ${response.status}`);
  }

  const data = await response.json();
  return data.webhooks || [];
}

async function deleteWebhook(webhookId: string): Promise<void> {
  const shopDomain = SHOPIFY_SHOP_DOMAIN!.replace("https://", "").replace("http://", "");
  const apiUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;

  const response = await fetch(`${apiUrl}/webhooks/${webhookId}.json`, {
    method: "DELETE",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN!,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete webhook ${webhookId}: ${response.status}`);
  }
}

async function createWebhook(webhook: {
  topic: string;
  address: string;
  format: string;
}): Promise<any> {
  const shopDomain = SHOPIFY_SHOP_DOMAIN!.replace("https://", "").replace("http://", "");
  const apiUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;

  const response = await fetch(`${apiUrl}/webhooks.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ webhook }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook ${webhook.topic}: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.webhook;
}

async function registerWebhooks() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_SHOP_DOMAIN) {
    console.log("\n❌ Shopify credentials not configured");
    return;
  }

  try {
    // 1. Get existing webhooks
    console.log("\n📋 Checking existing webhooks...");
    const existingWebhooks = await getExistingWebhooks();
    console.log(`   Found ${existingWebhooks.length} existing webhooks`);

    // 2. Delete existing webhooks that point to our deployment
    const battleBusWebhooks = existingWebhooks.filter(
      (w) => w.address.includes("battle-bus") || w.address.includes(DEPLOYMENT_URL)
    );

    if (battleBusWebhooks.length > 0) {
      console.log(`\n🗑️  Removing ${battleBusWebhooks.length} old Battle Bus webhooks...`);
      for (const webhook of battleBusWebhooks) {
        await deleteWebhook(webhook.id);
        console.log(`   Deleted: ${webhook.topic} → ${webhook.address}`);
      }
    }

    // 3. Register new webhooks
    console.log("\n📝 Registering new webhooks...");
    const registeredWebhooks = [];

    for (const webhookConfig of WEBHOOKS_TO_REGISTER) {
      try {
        const webhook = await createWebhook(webhookConfig);
        registeredWebhooks.push(webhook);
        console.log(`   ✅ ${webhookConfig.topic} → ${webhookConfig.address}`);
      } catch (error) {
        console.log(`   ❌ ${webhookConfig.topic}: ${error}`);
      }
    }

    // 4. Verify registration
    console.log("\n📋 Verifying webhook registration...");
    const finalWebhooks = await getExistingWebhooks();
    const battleBusFinal = finalWebhooks.filter(
      (w) => w.address.includes("battle-bus") || w.address.includes(DEPLOYMENT_URL)
    );

    console.log("\n" + "=".repeat(60));
    console.log("WEBHOOK REGISTRATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`\nRegistered ${battleBusFinal.length} webhooks:\n`);

    for (const webhook of battleBusFinal) {
      console.log(`  • ${webhook.topic}`);
      console.log(`    ID: ${webhook.id}`);
      console.log(`    URL: ${webhook.address}`);
      console.log("");
    }

    console.log("=".repeat(60));
    console.log("✅ WEBHOOK REGISTRATION COMPLETE");
    console.log("=".repeat(60));
    console.log("\nYour Battle Bus deployment will now receive:");
    console.log("  • orders/create     - New orders");
    console.log("  • orders/updated    - Order updates");
    console.log("  • orders/cancelled  - Cancellations");
    console.log("  • orders/fulfilled  - Fulfillments (STORD/HK)");
    console.log("  • refunds/create    - Refunds");
  } catch (error) {
    console.log(`\n❌ Error: ${error}`);
  }
}

registerWebhooks();
