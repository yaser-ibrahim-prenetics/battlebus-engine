/**
 * Test Lingxing ERP API for inventory
 * 
 * The Lingxing ERP API (openapi.lingxing.com) is DIFFERENT from the OMS API (api.xlwms.com)
 * 
 * ERP API uses OAuth (App ID + App Secret → Access Token)
 * OMS API uses HMAC SHA256 (App Key + App Secret + Signature)
 * 
 * Endpoints discovered from Python SDK:
 *   /erp/sc/routing/data/local_inventory/inventoryDetails - Seller Inventory
 *   /erp/sc/data/local_inventory/warehouse - Warehouses
 *   /erp/sc/routing/fba/fbaStock/fbaList - FBA Inventory
 * 
 * Run with: npx tsx scripts/test-lingxing-erp-inventory.ts
 */

import { config } from "@/lib/config";

// Lingxing ERP API base URL
const ERP_BASE_URL = "https://openapi.lingxing.com";

// Using OMS credentials - might work if they're the same account
// Otherwise you'd need separate Lingxing ERP credentials
const APP_ID = config.gpsUk.apiKey;
const APP_SECRET = config.gpsUk.apiSecret;

/**
 * Get OAuth access token from Lingxing ERP
 */
async function getAccessToken(): Promise<{ access_token: string; expires_in: number } | null> {
  console.log("Attempting to get OAuth access token from Lingxing ERP...\n");
  
  try {
    // Try query params format (as the error suggests appId should be a query param)
    const url = `${ERP_BASE_URL}/api/auth-server/oauth/access-token?appId=${APP_ID}&appSecret=${APP_SECRET}`;
    console.log("Trying URL:", url.replace(APP_SECRET, "***"));
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    
    const result = await response.json();
    console.log("Auth response:", JSON.stringify(result, null, 2));
    
    if (result.code === 0 && result.data?.access_token) {
      return result.data;
    }
    
    // Try form-urlencoded format
    console.log("\nTrying form-urlencoded format...");
    const formResponse = await fetch(`${ERP_BASE_URL}/api/auth-server/oauth/access-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `appId=${APP_ID}&appSecret=${APP_SECRET}`,
    });
    
    const formResult = await formResponse.json();
    console.log("Form auth response:", JSON.stringify(formResult, null, 2));
    
    if (formResult.code === 0 && formResult.data?.access_token) {
      return formResult.data;
    }
    
    return null;
  } catch (error) {
    console.error("Auth error:", error);
    return null;
  }
}

/**
 * Make authenticated request to Lingxing ERP API
 */
async function makeRequest(
  accessToken: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const timestamp = Math.floor(Date.now() / 1000);
  
  const response = await fetch(`${ERP_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      ...body,
      timestamp,
    }),
  });
  
  return response.json();
}

async function main() {
  console.log("=".repeat(70));
  console.log("LINGXING ERP API INVENTORY TEST");
  console.log("=".repeat(70));
  console.log(`ERP Base URL: ${ERP_BASE_URL}`);
  console.log(`App ID: ${APP_ID.slice(0, 8)}...`);
  console.log();
  
  // Step 1: Get OAuth access token
  const tokenResult = await getAccessToken();
  
  if (!tokenResult) {
    console.log("\n❌ Failed to get access token.");
    console.log("\nPossible reasons:");
    console.log("  1. OMS credentials (App Key/Secret) are different from ERP credentials");
    console.log("  2. You need to get Lingxing ERP App ID/Secret from a different location");
    console.log("  3. The ERP API requires separate registration");
    console.log("\nCheck the Lingxing ERP documentation at: https://openapidoc.lingxing.com");
    console.log("Or look for 'ERP API' settings in your Lingxing account.");
    return;
  }
  
  console.log(`\n✅ Got access token: ${tokenResult.access_token.slice(0, 20)}...`);
  console.log(`   Expires in: ${tokenResult.expires_in} seconds`);
  
  // Step 2: Test inventory endpoints
  console.log("\n" + "=".repeat(70));
  console.log("TESTING INVENTORY ENDPOINTS");
  console.log("=".repeat(70));
  
  const endpoints = [
    {
      name: "Warehouse List",
      path: "/erp/sc/data/local_inventory/warehouse",
      body: { offset: 0, length: 10, type: 1 },
    },
    {
      name: "Seller Inventory Details",
      path: "/erp/sc/routing/data/local_inventory/inventoryDetails",
      body: { offset: 0, length: 10 },
    },
    {
      name: "FBA Inventory",
      path: "/erp/sc/routing/fba/fbaStock/fbaList",
      body: { offset: 0, length: 10 },
    },
  ];
  
  for (const ep of endpoints) {
    console.log(`\nTesting: ${ep.name}`);
    console.log(`  Endpoint: ${ep.path}`);
    
    try {
      const result = await makeRequest(tokenResult.access_token, ep.path, ep.body);
      const resultStr = JSON.stringify(result, null, 2);
      
      if (resultStr.length > 500) {
        console.log(`  Result: ${resultStr.slice(0, 500)}...`);
      } else {
        console.log(`  Result: ${resultStr}`);
      }
      
      const code = (result as { code?: number }).code;
      if (code === 0) {
        console.log("  ✅ SUCCESS!");
      } else {
        console.log(`  ❌ Error code: ${code}`);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error}`);
    }
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("DONE");
  console.log("=".repeat(70));
}

main().catch(console.error);
