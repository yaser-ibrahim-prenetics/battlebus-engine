// ============================================================================
// SEED LOCATIONS FROM SHOPIFY TO BATTLE HUB
// ============================================================================
// This script fetches all locations from Shopify and sends them to Battle Hub
// to populate the locations table with location data and dynamics_data_area_id

import { config } from "dotenv";
config({ path: ".env.local" });

import * as shopify from "../src/lib/clients/shopify";
import * as csPlatform from "../src/lib/clients/cs-platform";
import { getDataAreaIdFromLocation, getWarehouseNameFromLocation } from "../src/lib/utils/validation";
import { config as appConfig } from "../src/lib/config";

const BATTLE_HUB_URL = process.env.CS_PLATFORM_URL || process.env.BATTLE_CS_URL || "https://battle-hub-three.vercel.app";

async function main() {
  console.log("=".repeat(70));
  console.log("SEED LOCATIONS FROM SHOPIFY TO BATTLE HUB");
  console.log("=".repeat(70));

  if (!BATTLE_HUB_URL) {
    console.error("❌ BATTLE_HUB_URL not configured. Please set CS_PLATFORM_URL or BATTLE_CS_URL in your .env.local file.");
    process.exit(1);
  }

  console.log("\n📋 Configuration:");
  console.log(`   Battle Hub URL: ${BATTLE_HUB_URL}`);
  console.log(`   Shopify Store: ${appConfig.shopify.im8.shopDomain || "N/A"}`);

  try {
    // Fetch all locations from Shopify
    console.log("\n🔄 Fetching locations from Shopify...");
    const locations = await shopify.getAllLocations();
    console.log(`   Found ${locations.length} location(s)`);

    if (locations.length === 0) {
      console.log("\n⚠️  No locations found in Shopify");
      return;
    }

    // Send each location to Battle Hub
    console.log("\n📤 Sending locations to Battle Hub...");
    let successCount = 0;
    let errorCount = 0;

    for (const location of locations) {
      try {
        const dataAreaId = getDataAreaIdFromLocation(location.id);
        const warehouseName = getWarehouseNameFromLocation(location.id, location.name);

        const locationData = {
          id: location.id,
          name: location.name,
          shopify_location_id: location.id,
          warehouse_name: warehouseName,
          dynamics_data_area_id: dataAreaId,
          address_line1: location.address1 || null,
          address_line2: location.address2 || null,
          city: location.city || null,
          province: location.province || null,
          country: location.country || null,
          zip: location.zip || null,
          phone: location.phone || null,
          active: location.active,
          fulfillment_service_id: location.fulfillment_service_id || null,
        };

        // Send to Battle Hub via webhook
        await csPlatform.sendLocationEvent({
          event: "location.created",
          data: locationData,
        });

        console.log(`   ✅ ${location.name} (${location.id}) - ${warehouseName} - ${dataAreaId}`);
        successCount++;
      } catch (error: any) {
        console.error(`   ❌ ${location.name} (${location.id}): ${error.message}`);
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
    console.error("\n❌ FAILED! Error seeding locations:", error.message);
    process.exit(1);
  }
}

main();

