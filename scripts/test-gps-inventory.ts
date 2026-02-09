/**
 * Test GPS Inventory API Connectivity
 * 
 * This script tests whether the GPS OMS API has inventory endpoints available
 * using your existing credentials.
 * 
 * Run with: npx tsx scripts/test-gps-inventory.ts
 */

import * as gpsInventory from "@/lib/clients/gps-inventory";

async function main() {
  console.log("=".repeat(60));
  console.log("GPS INVENTORY API CONNECTIVITY TEST");
  console.log("=".repeat(60));
  console.log();

  // Test UK region (using your provided credentials)
  console.log("Testing UK Region (oms.xlwms.com)...");
  console.log("-".repeat(40));
  
  const ukResult = await gpsInventory.testInventoryConnection("UK");
  console.log(`Success: ${ukResult.success}`);
  console.log(`Message: ${ukResult.message}`);
  if (ukResult.availableEndpoints) {
    console.log(`Available Endpoints: ${ukResult.availableEndpoints.join(", ")}`);
  }
  console.log();

  // Test US region
  console.log("Testing US Region...");
  console.log("-".repeat(40));
  
  const usResult = await gpsInventory.testInventoryConnection("US");
  console.log(`Success: ${usResult.success}`);
  console.log(`Message: ${usResult.message}`);
  if (usResult.availableEndpoints) {
    console.log(`Available Endpoints: ${usResult.availableEndpoints.join(", ")}`);
  }
  console.log();

  // If any region has inventory endpoints, try a sample query
  if (ukResult.success || usResult.success) {
    console.log("Attempting sample inventory query...");
    console.log("-".repeat(40));
    
    const region = ukResult.success ? "UK" : "US";
    
    try {
      const items = await gpsInventory.queryOmsInventory({
        region,
        pageSize: 10,
      });
      
      console.log(`Query returned ${items.length} items`);
      
      if (items.length > 0) {
        console.log("\nSample inventory items:");
        for (const item of items.slice(0, 5)) {
          console.log(`  - ${item.sku}: ${item.availableQty} available, ${item.lockedQty} locked`);
        }
      }
    } catch (error) {
      console.log(`Query error: ${error}`);
    }
  } else {
    console.log("=".repeat(60));
    console.log("RESULT: No inventory endpoints available");
    console.log("=".repeat(60));
    console.log();
    console.log("Your GPS account appears to only support order management.");
    console.log("To enable inventory queries, you may need to:");
    console.log("  1. Contact GPS/Lingxing support to enable inventory API access");
    console.log("  2. Check if there's a separate inventory API subscription");
    console.log("  3. Use the Lingxing ERP system instead (requires separate credentials)");
    console.log();
    console.log("Alternative: Use D365 as the source of truth for inventory,");
    console.log("and sync GPS -> D365 based on order fulfillment data.");
  }

  console.log();
  console.log("=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
}

main().catch(console.error);
