// ============================================================================
// MANUAL SCRIPT: SEED LOCATIONS WITH INVENTORY FROM SHOPIFY TO BATTLE HUB
// ============================================================================
// This script manually fetches all locations from Shopify, gets inventory
// for each location, and seeds them to Battle Hub

import { config } from "dotenv";
config({ path: ".env.local" });

import { config as appConfig } from "../src/lib/config";
import { getDataAreaIdFromLocation, getWarehouseNameFromLocation } from "../src/lib/utils/validation";
import crypto from "crypto";

const BATTLE_HUB_URL = process.env.CS_PLATFORM_URL || process.env.BATTLE_CS_URL || "https://battle-hub-three.vercel.app";
const WEBHOOK_SECRET = process.env.CS_PLATFORM_WEBHOOK_SECRET || process.env.BATTLE_BUS_WEBHOOK_SECRET || "";

const SHOPIFY_DOMAIN = appConfig.shopify.im8.shopDomain;
const SHOPIFY_TOKEN = appConfig.shopify.im8.accessToken;
const SHOPIFY_API_VERSION = appConfig.shopify.im8.apiVersion;

function generateSignature(payload: string): string {
  if (!WEBHOOK_SECRET) return "";
  return crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
}

async function fetchShopify(endpoint: string) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function getAllLocations() {
  const data = await fetchShopify("/locations.json");
  return (data.locations || []).map((loc: any) => ({
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

async function getInventoryForLocation(locationId: string) {
  const data = await fetchShopify(`/inventory_levels.json?location_ids=${locationId}`);
  const inventoryLevels = data.inventory_levels || [];

  // Fetch variant details to get SKU info
  const inventoryItemIds = inventoryLevels.map((level: any) => level.inventory_item_id);
  const variantMap = new Map<number, { sku?: string; variant_id?: number; product_id?: number }>();

  if (inventoryItemIds.length > 0) {
    try {
      // Fetch in batches of 250 (Shopify limit)
      const batchSize = 250;
      for (let i = 0; i < inventoryItemIds.length; i += batchSize) {
        const batch = inventoryItemIds.slice(i, i + batchSize);
        const variantsData = await fetchShopify(`/variants.json?ids=${batch.join(",")}`);
        const variants = variantsData.variants || [];
        for (const variant of variants) {
          if (variant.inventory_item_id) {
            variantMap.set(variant.inventory_item_id, {
              sku: variant.sku || undefined,
              variant_id: variant.id,
              product_id: variant.product_id,
            });
          }
        }
      }
    } catch (error) {
      console.warn(`   ⚠️  Failed to fetch variant details: ${error}`);
    }
  }

  return inventoryLevels.map((level: any) => {
    const variantInfo = variantMap.get(level.inventory_item_id) || {};
    return {
      inventory_item_id: level.inventory_item_id,
      available: level.available || 0,
      sku: variantInfo.sku,
      variant_id: variantInfo.variant_id,
      product_id: variantInfo.product_id,
    };
  });
}

async function sendToBattleHub(locationData: any) {
  const payload = {
    event: "location.created",
    data: locationData,
  };

  const payloadString = JSON.stringify(payload);
  const signature = generateSignature(payloadString);

  const response = await fetch(`${BATTLE_HUB_URL}/api/webhooks/locations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Battle-Bus-Signature": signature,
    },
    body: payloadString,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Battle Hub API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function main() {
  console.log("=".repeat(70));
  console.log("SEED LOCATIONS WITH INVENTORY FROM SHOPIFY TO BATTLE HUB");
  console.log("=".repeat(70));

  if (!BATTLE_HUB_URL) {
    console.error("❌ BATTLE_HUB_URL not configured");
    process.exit(1);
  }

  console.log("\n📋 Configuration:");
  console.log(`   Battle Hub URL: ${BATTLE_HUB_URL}`);
  console.log(`   Shopify Store: ${SHOPIFY_DOMAIN}`);

  try {
    // Fetch all locations
    console.log("\n🔄 Fetching locations from Shopify...");
    const locations = await getAllLocations();
    console.log(`   Found ${locations.length} location(s)`);

    if (locations.length === 0) {
      console.log("\n⚠️  No locations found");
      return;
    }

    // Process each location
    console.log("\n📤 Seeding locations with inventory to Battle Hub...");
    let successCount = 0;
    let errorCount = 0;

    for (const location of locations) {
      try {
        console.log(`\n   📍 Processing: ${location.name} (${location.id})`);

        // Get warehouse mapping
        const dataAreaId = getDataAreaIdFromLocation(location.id);
        const warehouseName = getWarehouseNameFromLocation(location.id, location.name);
        console.log(`      Warehouse: ${warehouseName}, Data Area: ${dataAreaId}`);

        // Fetch inventory for this location
        console.log(`      📦 Fetching inventory...`);
        const inventoryLevels = await getInventoryForLocation(location.id);
        console.log(`      Found ${inventoryLevels.length} inventory item(s)`);

        // Prepare location data
        const locationData = {
          id: location.id,
          name: location.name,
          shopify_location_id: location.id,
          warehouse_name: warehouseName,
          dynamics_data_area_id: dataAreaId,
          address_line1: location.address1,
          address_line2: location.address2,
          city: location.city,
          province: location.province,
          country: location.country,
          zip: location.zip,
          phone: location.phone,
          active: location.active,
          fulfillment_service_id: location.fulfillment_service_id,
          inventory_levels: inventoryLevels,
        };

        // Send to Battle Hub
        await sendToBattleHub(locationData);
        console.log(`      ✅ Sent to Battle Hub`);

        successCount++;
      } catch (error: any) {
        console.error(`      ❌ Error: ${error.message}`);
        errorCount++;
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("SUMMARY:");
    console.log(`   Total: ${locations.length}`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Errors: ${errorCount}`);
    console.log("=".repeat(70));
  } catch (error: any) {
    console.error("\n❌ FAILED! Error:", error.message);
    process.exit(1);
  }
}

main();

