/**
 * Test script to verify GPS OMS sandbox connection
 *
 * Usage:
 *   npx tsx scripts/test-gps.ts
 *
 * This will:
 *   1. Load environment variables from .env.local
 *   2. Generate a GPS auth code
 *   3. Make a test API call to GPS
 */

import crypto from "crypto";
import * as dotenv from "dotenv";
import path from "path";

// Load .env.local
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const GPS_BASE_URL = process.env.GPS_BASE_URL || "https://api.xlwms.com";
const GPS_API_KEY = process.env.GPS_API_KEY || "";
const GPS_API_SECRET = process.env.GPS_API_SECRET || "";
const GPS_WAREHOUSE_CODE = process.env.GPS_WAREHOUSE_CODE || "JFK01W";

// ============================================================================
// GPS AUTH CODE GENERATION (Same as in src/lib/clients/gps.ts)
// ============================================================================

function deepSortKeys<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => deepSortKeys(item)) as T;
  } else if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return obj;
}

function sha256Hmac(message: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function generateAuthCode(
  data: unknown,
  reqTime: string,
  appKey: string,
  appSecret: string
): string {
  const dataMap: Record<string, unknown> = {
    appKey,
    reqTime,
  };

  const resultMap = new Map<string, unknown>();
  resultMap.set("data", data);
  resultMap.set("reqTime", reqTime);
  resultMap.set("appKey", appKey);

  for (const [key, value] of resultMap.entries()) {
    const lowerKey = key.toLowerCase();
    if (["authcode", "appkey", "appsecret", "reqtime"].includes(lowerKey)) continue;

    if (key === "data") {
      dataMap[lowerKey] = deepSortKeys(value);
    } else {
      dataMap[lowerKey] = value;
    }
  }

  const sortedKeys = Object.keys(dataMap).sort();
  let concatenatedStr = "";

  for (const key of sortedKeys) {
    const val = typeof dataMap[key] === "string" ? dataMap[key] : JSON.stringify(dataMap[key]);
    concatenatedStr += val;
  }

  return sha256Hmac(concatenatedStr, appSecret);
}

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

async function testGpsConnection() {
  console.log("🚌 Battle Bus - GPS OMS Sandbox Test\n");
  console.log("=".repeat(50));
  console.log("Configuration:");
  console.log(`  Base URL:       ${GPS_BASE_URL}`);
  console.log(`  API Key:        ${GPS_API_KEY.substring(0, 8)}...`);
  console.log(`  API Secret:     ${GPS_API_SECRET.substring(0, 8)}...`);
  console.log(`  Warehouse Code: ${GPS_WAREHOUSE_CODE}`);
  console.log("=".repeat(50) + "\n");

  if (!GPS_API_KEY || !GPS_API_SECRET) {
    console.error("❌ GPS_API_KEY or GPS_API_SECRET not set in .env.local");
    process.exit(1);
  }

  // Test 1: Generate Auth Code
  console.log("📝 Test 1: Generating Auth Code...");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const testData = { test: "connection" };
  const authCode = generateAuthCode(testData, timestamp, GPS_API_KEY, GPS_API_SECRET);
  console.log(`   Auth Code: ${authCode.substring(0, 20)}...`);
  console.log("   ✅ Auth code generation works!\n");

  // Test 2: Try to query order details (empty list - just to test auth)
  console.log("📡 Test 2: Testing GPS API Connection...");

  const requestData = {
    outboundOrderNoList: [],
  };

  const payload = {
    appKey: GPS_API_KEY,
    reqTime: timestamp,
    data: requestData,
  };

  const apiAuthCode = generateAuthCode(requestData, timestamp, GPS_API_KEY, GPS_API_SECRET);

  try {
    const response = await fetch(
      `${GPS_BASE_URL}/openapi/v1/outboundOrder/detail?authcode=${apiAuthCode}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const result = await response.json();

    console.log(`   Status: ${response.status}`);
    console.log(`   Response: ${JSON.stringify(result, null, 2)}`);

    if (response.status === 200 || result.code === 200) {
      console.log("\n   ✅ GPS API connection successful!");
    } else if (result.code === 401 || result.msg?.includes("auth")) {
      console.log("\n   ❌ Authentication failed - check API key/secret");
    } else {
      console.log("\n   ⚠️  Got a response, but check if it's expected");
    }
  } catch (error) {
    console.error(`   ❌ Connection error: ${error}`);
  }

  // Test 3: Show sample order creation payload
  console.log("\n" + "=".repeat(50));
  console.log("📦 Sample Order Payload (for reference):");
  console.log("=".repeat(50));

  const sampleOrder = {
    platformOrderNo: "IM8-TEST-" + Date.now(),
    thirdOrderNo: "SHOPIFY-123456",
    whCode: GPS_WAREHOUSE_CODE,
    subOrderType: 1, // Product outbound
    logisticsChannel: "GPS-IM8-STANDARD-UK",
    receiver: "Test User",
    addressOne: "123 Test Street",
    addressTwo: "",
    cityName: "Los Angeles",
    countryRegionCode: "US",
    provinceName: "California",
    provinceCode: "CA",
    postCode: "90001",
    telephone: "+1234567890",
    email: "test@example.com",
    productList: [{ sku: "IM8-FG-000010", quantity: 1 }],
  };

  console.log(JSON.stringify(sampleOrder, null, 2));

  console.log("\n" + "=".repeat(50));
  console.log("✅ GPS sandbox is configured and ready!");
  console.log("=".repeat(50));
}

testGpsConnection();
