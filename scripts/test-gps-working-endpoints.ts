/**
 * Test GPS endpoints that we KNOW should work (outbound order)
 * to confirm the signature and permissions are correct
 */

import { generateAuthCode } from "@/lib/clients/gps";
import { config } from "@/lib/config";

const API_KEY = config.gpsUk.apiKey;
const API_SECRET = config.gpsUk.apiSecret;
const BASE_URL = config.gpsUk.baseUrl;

async function makeRequest(
  endpoint: string,
  data: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const authCode = generateAuthCode(data, timestamp, API_KEY, API_SECRET);

  const requestBody = {
    appKey: API_KEY,
    data,
    reqTime: timestamp,
  };

  const url = `${BASE_URL}${endpoint}?authcode=${authCode}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  return { status: response.status, body: await response.json() };
}

async function main() {
  console.log("=".repeat(60));
  console.log("TEST GPS WORKING ENDPOINTS");
  console.log("=".repeat(60));
  console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
  console.log();

  // Test 1: outboundOrder/detail - this should work
  console.log("1. Testing /openapi/v1/outboundOrder/detail (should work):");
  const detailResult = await makeRequest("/openapi/v1/outboundOrder/detail", {
    outboundOrderNoList: ["TEST-ORDER-12345"],
  });
  console.log("   Response:", JSON.stringify(detailResult.body, null, 2));
  console.log();

  // Test 2: outboundOrder/create - would work but we don't want to create orders
  // Let's test with invalid data to see if we get a param error vs permission error
  console.log("2. Testing /openapi/v1/outboundOrder/create (with empty data):");
  const createResult = await makeRequest("/openapi/v1/outboundOrder/create", []);
  console.log("   Response:", JSON.stringify(createResult.body, null, 2));
  console.log();

  // Test 3: inventory/list - should return permission denied
  console.log("3. Testing /openapi/v1/inventory/list (expect permission denied):");
  const inventoryResult = await makeRequest("/openapi/v1/inventory/list", {
    page: 1,
    pageSize: 10,
  });
  console.log("   Response:", JSON.stringify(inventoryResult.body, null, 2));
  console.log();

  // Summary
  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const detailCode = (detailResult.body as { code: number }).code;
  const createCode = (createResult.body as { code: number }).code;
  const invCode = (inventoryResult.body as { code: number }).code;

  console.log(
    `outboundOrder/detail: code=${detailCode} ${detailCode === 200 || detailCode === 0 ? "✅ WORKS" : detailCode === 11008 ? "❌ NO PERMISSION" : "⚠️ OTHER ERROR"}`
  );
  console.log(
    `outboundOrder/create: code=${createCode} ${createCode === 200 || createCode === 0 ? "✅ WORKS" : createCode === 11008 ? "❌ NO PERMISSION" : "⚠️ PARAM/OTHER ERROR (expected)"}`
  );
  console.log(
    `inventory/list:       code=${invCode} ${invCode === 200 || invCode === 0 ? "✅ WORKS" : invCode === 11008 ? "❌ NO PERMISSION" : "⚠️ OTHER ERROR"}`
  );
}

main().catch(console.error);
