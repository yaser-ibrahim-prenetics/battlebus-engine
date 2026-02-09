/**
 * Test Inventory Age endpoints specifically
 * Based on OMS documentation showing inventory age features
 * 
 * Run with: npx tsx scripts/test-inventory-age-endpoints.ts
 */

import { generateAuthCode } from "@/lib/clients/gps";
import { config } from "@/lib/config";

const API_KEY = config.gpsUk.apiKey;
const API_SECRET = config.gpsUk.apiSecret;
const BASE_URL = config.gpsUk.baseUrl;

async function testEndpoint(endpoint: string, data: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const authCode = generateAuthCode(data, timestamp, API_KEY, API_SECRET);

  const requestBody = { appKey: API_KEY, data, reqTime: timestamp };

  try {
    const response = await fetch(`${BASE_URL}${endpoint}?authcode=${authCode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return await response.json();
  } catch (error) {
    return { error: String(error) };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("INVENTORY AGE ENDPOINT TEST");
  console.log("Based on OMS documentation paths:");
  console.log("  [Inventory - Product Inventory Age]");
  console.log("  [Inventory - Box Age]");
  console.log("  [Inventory - Returns Inventory Age]");
  console.log("=".repeat(70));
  console.log();

  // Based on the documentation paths, try various endpoint patterns
  const endpoints = [
    // Product Inventory Age (from docs: Inventory - Product Inventory Age)
    "/openapi/v1/inventory/productAge",
    "/openapi/v1/inventory/product/age",
    "/openapi/v1/inventoryAge/product",
    "/openapi/v1/product/inventoryAge",
    "/openapi/v1/productInventoryAge/list",
    "/openapi/v1/productInventoryAge/query",
    
    // Box/Container Age (from docs: Inventory - Box Age)
    "/openapi/v1/inventory/boxAge",
    "/openapi/v1/inventory/box/age",
    "/openapi/v1/inventoryAge/box",
    "/openapi/v1/boxAge/list",
    "/openapi/v1/containerAge/list",
    
    // Returns Inventory Age (from docs: Inventory - Returns Inventory Age)
    "/openapi/v1/inventory/returnAge",
    "/openapi/v1/inventory/returns/age",
    "/openapi/v1/inventoryAge/return",
    "/openapi/v1/returnInventoryAge/list",
    
    // General inventory age
    "/openapi/v1/inventoryAge/list",
    "/openapi/v1/inventoryAge/query",
    "/openapi/v1/inventory/age/list",
    "/openapi/v1/inventory/age/query",
    
    // Stock age variations
    "/openapi/v1/stockAge/list",
    "/openapi/v1/stock/age/list",
    
    // Report endpoints (inventory reports)
    "/openapi/v1/report/inventoryAge",
    "/openapi/v1/report/productInventoryAge",
    "/openapi/v1/report/stockAge",
    
    // Statistics endpoints
    "/openapi/v1/statistics/inventory",
    "/openapi/v1/statistics/inventoryAge",
    
    // Data endpoints
    "/openapi/v1/data/inventoryAge",
    "/openapi/v1/data/inventory",
    
    // Warehouse inventory
    "/openapi/v1/warehouse/inventory",
    "/openapi/v1/warehouse/stock",
    "/openapi/v1/wh/inventory",
  ];

  const baseData = {
    page: 1,
    pageSize: 10,
    whCode: "LHR", // UK warehouse
  };

  for (const ep of endpoints) {
    process.stdout.write(`${ep.padEnd(50)} `);
    const result = await testEndpoint(ep, baseData);
    
    const code = result.code;
    if (code === 200 || code === 0) {
      console.log(`✅ SUCCESS! - ${JSON.stringify(result).slice(0, 80)}`);
    } else if (code === 11008 || code === "11008") {
      console.log(`🔒 NO PERMISSION`);
    } else if (code === 11001) {
      console.log(`⚪ NOT FOUND`);
    } else if (code === 400 || code === 1001 || code === 1002 || code === 10001) {
      console.log(`⚠️  PARAM ERROR (exists!) - ${result.msg || result.message}`);
    } else {
      console.log(`❓ ${code} - ${(result.msg || result.message || "").slice(0, 40)}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("CONCLUSION");
  console.log("=".repeat(70));
  console.log("\nIf all endpoints show 'NO PERMISSION' (11008), it means:");
  console.log("  1. The endpoints EXIST on the API");
  console.log("  2. Your App Key doesn't have permission to access them");
  console.log("  3. You need to contact GPS support OR check the ERP tab for different credentials");
}

main().catch(console.error);
