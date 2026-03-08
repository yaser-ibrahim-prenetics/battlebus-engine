/**
 * Test GPS Connection
 * Run with: npx tsx scripts/test-gps-connection.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import crypto from "crypto";

const GPS_BASE_URL = process.env.GPS_BASE_URL;
const GPS_API_KEY = process.env.GPS_API_KEY;
const GPS_API_SECRET = process.env.GPS_API_SECRET;
const GPS_WAREHOUSE_CODE = process.env.GPS_WAREHOUSE_CODE;

console.log("=".repeat(60));
console.log("GPS Connection Test");
console.log("=".repeat(60));

// Check config
console.log("\n📋 Configuration:");
console.log(`  Base URL: ${GPS_BASE_URL}`);
console.log(`  API Key: ${GPS_API_KEY}`);
console.log(`  API Secret: ${GPS_API_SECRET ? "***" + GPS_API_SECRET.slice(-4) : "NOT SET"}`);
console.log(`  Warehouse Code: ${GPS_WAREHOUSE_CODE}`);

// GPS Auth Code Generation (from gps.ts)
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

async function testConnection() {
  if (!GPS_API_KEY || !GPS_API_SECRET) {
    console.log("\n❌ GPS credentials not configured");
    return;
  }

  // Test: Query order details (empty list is fine, just testing auth)
  console.log("\n🔐 Testing GPS API Authentication...");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestData = {
    outboundOrderNoList: ["TEST-ORDER-123"], // Dummy order to test auth
  };

  const payload = {
    appKey: GPS_API_KEY,
    reqTime: timestamp,
    data: requestData,
  };

  const authCode = generateAuthCode(requestData, timestamp, GPS_API_KEY, GPS_API_SECRET);

  console.log(`   Timestamp: ${timestamp}`);
  console.log(`   Auth Code: ${authCode.slice(0, 20)}...`);

  try {
    const response = await fetch(
      `${GPS_BASE_URL}/openapi/v1/outboundOrder/detail?authcode=${authCode}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const result = await response.json();

    console.log(`\n📦 GPS API Response:`);
    console.log(`   Status Code: ${response.status}`);
    console.log(`   Response Code: ${result.code}`);
    console.log(`   Message: ${result.msg}`);

    if (result.code === 200) {
      console.log(`\n✅ GPS Authentication SUCCESS`);
      console.log(`   Orders found: ${result.data?.length || 0}`);
    } else if (result.code === 401 || result.msg?.toLowerCase().includes("auth")) {
      console.log(`\n❌ GPS Authentication FAILED`);
      console.log(`   Check API Key and Secret`);
    } else {
      console.log(`\n⚠️ GPS API returned code ${result.code}`);
      console.log(`   This may be expected for test query`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ GPS CONNECTION TEST COMPLETE");
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`\n❌ Connection Error: ${error}`);
  }
}

testConnection();
