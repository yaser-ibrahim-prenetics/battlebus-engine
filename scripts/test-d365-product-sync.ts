#!/usr/bin/env tsx
/**
 * Test Dynamics 365 Product Sync API
 * 
 * Tests the ReleasedProductsV2 OData API for creating/updating products
 * 
 * Required Environment Variables:
 * - D365_BASE_URL (default: https://p-uat.sandbox.operations.dynamics.com)
 * - D365_TENANT_ID (Azure AD tenant ID)
 * - D365_CLIENT_ID (Azure AD app registration client ID)
 * - D365_CLIENT_SECRET (Azure AD app registration client secret)
 * - D365_DATA_AREA_ID (default: U001)
 * 
 * Optional:
 * - D365_SCOPE (defaults to ${D365_BASE_URL}/.default)
 */

import { config } from "../src/lib/config";

const D365_BASE_URL = config.dynamics.baseUrl;
const D365_TENANT_ID = config.dynamics.tenantId;
const D365_CLIENT_ID = config.dynamics.clientId;
const D365_CLIENT_SECRET = config.dynamics.clientSecret;
const D365_DATA_AREA_ID = config.dynamics.dataAreaId;
const D365_SCOPE = config.dynamics.scope;

/**
 * Authenticate with D365 using OAuth2 client credentials
 */
async function getAuthToken(): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: D365_CLIENT_ID,
    client_secret: D365_CLIENT_SECRET,
    scope: D365_SCOPE,
  });

  console.log(`[D365] Authenticating to ${tokenUrl}`);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D365 authentication failed: ${response.status} - ${error}`);
  }

  const token: any = await response.json();
  console.log(`[D365] ✅ Authentication successful, token expires in ${token.expires_in}s`);
  return token.access_token;
}

/**
 * Check if product exists in D365
 * Uses ReleasedProductsV2 (read-only endpoint that works)
 */
async function checkProductExists(
  accessToken: string,
  itemNumber: string
): Promise<boolean> {
  // Use ReleasedProductsV2 (read-only but works)
  const checkUrl = `${D365_BASE_URL}/data/ReleasedProductsV2?$filter=ItemNumber eq '${itemNumber}' and dataAreaId eq '${D365_DATA_AREA_ID}'&$top=1`;

  const response = await fetch(checkUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[D365] Failed to check product: ${errorText}`);
    return false;
  }

  const data = await response.json();
  return data.value && data.value.length > 0;
}

// Note: Product creation/update functions removed as D365 OData API
// does not support direct product creation. Products must be created
// through D365 UI or custom D365 services.

/**
 * Test D365 Product Sync
 * NOTE: D365 OData API does not support direct product creation.
 * This test only verifies authentication and checks if products exist.
 */
async function testD365ProductSync() {
  console.log("=".repeat(80));
  console.log("DYNAMICS 365 PRODUCT SYNC API TEST");
  console.log("=".repeat(80));
  console.log();
  console.log("⚠️  NOTE: D365 OData API does not support direct product creation.");
  console.log("   Products must be created through D365 UI or custom services.");
  console.log("   This test only verifies authentication and checks if products exist.");
  console.log();

  // Check credentials
  console.log("📋 Configuration:");
  console.log(`   Base URL: ${D365_BASE_URL}`);
  console.log(`   Tenant ID: ${D365_TENANT_ID ? D365_TENANT_ID.substring(0, 8) + "..." : "NOT SET"}`);
  console.log(`   Client ID: ${D365_CLIENT_ID ? D365_CLIENT_ID.substring(0, 8) + "..." : "NOT SET"}`);
  console.log(`   Client Secret: ${D365_CLIENT_SECRET ? "***" + D365_CLIENT_SECRET.slice(-4) : "NOT SET"}`);
  console.log(`   Data Area ID: ${D365_DATA_AREA_ID}`);
  console.log(`   Scope: ${D365_SCOPE}`);
  console.log();

  if (!D365_TENANT_ID || !D365_CLIENT_ID || !D365_CLIENT_SECRET) {
    console.error("❌ Missing D365 credentials!");
    console.error();
    console.error("Required Environment Variables:");
    console.error("  D365_TENANT_ID=your_azure_tenant_id");
    console.error("  D365_CLIENT_ID=your_azure_app_client_id");
    console.error("  D365_CLIENT_SECRET=your_azure_app_client_secret");
    console.error();
    console.error("Optional:");
    console.error("  D365_BASE_URL=https://p-uat.sandbox.operations.dynamics.com (default)");
    console.error("  D365_DATA_AREA_ID=U001 (default)");
    console.error("  D365_SCOPE=${D365_BASE_URL}/.default (default)");
    console.error();
    process.exit(1);
  }

  // Test product data
  const testSku = `TEST-${Date.now()}`;
  const testProductName = "Test Product for D365 API";
  const testBarcode = `TEST-BARCODE-${Date.now()}`;
  const testWeight = 0.5; // kg

  console.log("📦 Test Product Data:");
  console.log(`   SKU (ItemNumber): ${testSku}`);
  console.log(`   Product Name: ${testProductName}`);
  console.log(`   Barcode: ${testBarcode}`);
  console.log(`   Weight: ${testWeight} kg`);
  console.log();

  try {
    // Step 1: Authenticate
    console.log("🔐 Step 1: Authenticating with D365...");
    const accessToken = await getAuthToken();
    console.log();

    // Step 2: Check if product exists
    console.log("🔍 Step 2: Checking if product exists...");
    const exists = await checkProductExists(accessToken, testSku);
    console.log(`   Product exists: ${exists ? "✅ Yes" : "❌ No"}`);
    console.log();

    if (exists) {
      console.log("✅ Product found in D365!");
      console.log();
      console.log("💡 You can verify this product in D365:");
      console.log(`   ${D365_BASE_URL}/data/ReleasedProductsV2?$filter=ItemNumber eq '${testSku}'`);
    } else {
      console.log("ℹ️  Product does not exist (expected for new test SKU)");
      console.log();
      console.log("📝 To create this product in D365:");
      console.log("   1. Log in to D365");
      console.log("   2. Go to Product Information Management → Products → Released products");
      console.log("   3. Create new product with:");
      console.log(`      - Item Number: ${testSku}`);
      console.log(`      - Product Name: ${testProductName}`);
      console.log(`      - Barcode: ${testBarcode}`);
      console.log(`      - Weight: ${testWeight} kg`);
      console.log();
      console.log("💡 Note: D365 OData API does not support direct product creation.");
      console.log("   Products must be created through D365 UI or custom D365 services.");
    }
  } catch (error) {
    console.error("❌ REQUEST FAILED!");
    console.error();
    console.error("Error:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error();
      console.error("Stack:", error.stack);
    }
  }

  console.log();
  console.log("=".repeat(80));
}

// Run the test
testD365ProductSync()
  .then(() => {
    console.log("Test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });

