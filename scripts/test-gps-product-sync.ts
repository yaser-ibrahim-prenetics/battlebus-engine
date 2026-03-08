#!/usr/bin/env tsx
/**
 * Test GPS Product Batch Create API
 *
 * Tests the /openapi/v1/product/batchCreate endpoint
 *
 * Required Environment Variables:
 * - GPS_BASE_URL (default: https://api.xlwms.com)
 * - GPS_API_KEY (your GPS appKey)
 * - GPS_API_SECRET (your GPS appSecret)
 *
 * Optional:
 * - GPS_UK_API_KEY (for GPS UK Warehouse)
 * - GPS_UK_API_SECRET (for GPS UK Warehouse)
 * - GPS_UK_BASE_URL (defaults to GPS_BASE_URL)
 */

import { config } from "../src/lib/config";
import { generateAuthCode } from "../src/lib/clients/gps";

const GPS_BASE_URL = config.gps.baseUrl;
const GPS_API_KEY = config.gps.apiKey;
const GPS_API_SECRET = config.gps.apiSecret;

function epochInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Test GPS Product Batch Create API
 */
async function testGpsProductBatchCreate() {
  console.log("=".repeat(80));
  console.log("GPS PRODUCT BATCH CREATE API TEST");
  console.log("=".repeat(80));
  console.log();

  // Check credentials
  console.log("📋 Configuration:");
  console.log(`   Base URL: ${GPS_BASE_URL}`);
  console.log(`   API Key: ${GPS_API_KEY ? GPS_API_KEY.substring(0, 8) + "..." : "NOT SET"}`);
  console.log(`   API Secret: ${GPS_API_SECRET ? "***" + GPS_API_SECRET.slice(-4) : "NOT SET"}`);
  console.log();

  if (!GPS_API_KEY || !GPS_API_SECRET) {
    console.error("❌ Missing GPS API credentials!");
    console.error();
    console.error("Required Environment Variables:");
    console.error("  GPS_API_KEY=your_app_key");
    console.error("  GPS_API_SECRET=your_app_secret");
    console.error();
    console.error("Optional:");
    console.error("  GPS_BASE_URL=https://api.xlwms.com (default)");
    console.error();
    process.exit(1);
  }

  // Create a test product
  const testProduct = {
    sku: `TEST-${Date.now()}`, // Unique SKU for testing
    productCode: `TEST-BARCODE-${Date.now()}`, // EAN/UPC barcode
    productName: "Test Product for GPS API",
    productAliasName: "Test Product",
    productDescription: "This is a test product created via GPS API",
    length: "10",
    width: "10",
    height: "5",
    sizeUnit: "cm",
    weight: "0.5",
    weightUnit: "kg",
    declareNameCn: "测试产品",
    declareNameEn: "Test Product",
    customhouseCode: "",
    declarePrice: "10.00",
    currencyCode: "USD",
    countryOfOriginName: "CN",
    dangerousCargo: "1", // 1 = General cargo (non-dangerous)
  };

  console.log("📦 Test Product Data:");
  console.log(JSON.stringify(testProduct, null, 2));
  console.log();

  // Build request payload
  const timestamp = epochInSeconds().toString();
  const productDataArray = [testProduct];

  const payload = {
    appKey: GPS_API_KEY,
    data: productDataArray,
    reqTime: timestamp,
  };

  // Generate authcode
  const authCode = generateAuthCode(productDataArray, timestamp, GPS_API_KEY, GPS_API_SECRET);

  console.log("🔐 Authentication:");
  console.log(`   Timestamp: ${timestamp}`);
  console.log(`   Authcode: ${authCode.substring(0, 16)}...`);
  console.log();

  // Make API request
  const url = `${GPS_BASE_URL}/openapi/v1/product/batchCreate?authcode=${authCode}`;
  console.log("📡 Making API Request:");
  console.log(`   URL: ${url}`);
  console.log(`   Method: POST`);
  console.log();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result: any = await response.json();

    console.log("📥 API Response:");
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Code: ${result.code}`);
    console.log(`   Message: ${result.msg || "N/A"}`);
    console.log();

    if (result.code === 200) {
      console.log("✅ SUCCESS!");
      console.log();

      if (result.data && Array.isArray(result.data)) {
        console.log("📊 Product Results:");
        result.data.forEach((item: any, index: number) => {
          console.log(`   Product ${index + 1}:`);
          console.log(`     SKU: ${item.sku || testProduct.sku}`);
          console.log(`     Success: ${item.success ? "✅ Yes" : "❌ No"}`);
          if (item.message) {
            console.log(`     Message: ${item.message}`);
          }
        });
      } else {
        console.log("✅ Products created successfully (no errors returned)");
      }
    } else {
      console.error("❌ FAILED!");
      console.error();
      console.error("Error Details:");
      console.error(JSON.stringify(result, null, 2));

      // Common error codes from GPS documentation
      if (result.code === "100001") {
        console.error();
        console.error("💡 Hint: authcode verification code is empty");
      } else if (result.code === "100002") {
        console.error();
        console.error("💡 Hint: Timeout - request timestamp is too old (>5 minutes)");
      } else if (result.code === "100007") {
        console.error();
        console.error("💡 Hint: authcode verification failed - check API secret");
      } else if (result.code === "100008") {
        console.error();
        console.error("💡 Hint: Missing required parameters");
      } else if (result.code === "100010") {
        console.error();
        console.error("💡 Hint: No API permission - contact GPS support");
      }
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
testGpsProductBatchCreate()
  .then(() => {
    console.log("Test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
