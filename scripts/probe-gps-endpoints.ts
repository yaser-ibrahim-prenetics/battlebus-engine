/**
 * Probe GPS OMS API for available endpoints
 *
 * This script tries various common WMS/OMS API endpoints to discover
 * what's actually available on the api.xlwms.com service.
 *
 * Uses the CORRECT signature algorithm from battle-bus gps.ts client.
 *
 * Run with: npx tsx scripts/probe-gps-endpoints.ts
 */

import { generateAuthCode } from "@/lib/clients/gps";
import { config } from "@/lib/config";

// Use credentials from config (already on Vercel)
const API_KEY = config.gpsUk.apiKey;
const API_SECRET = config.gpsUk.apiSecret;
const BASE_URL = config.gpsUk.baseUrl;

console.log("Using credentials from config:");
console.log(`  API Key: ${API_KEY.slice(0, 8)}...`);
console.log(`  Base URL: ${BASE_URL}`);

/**
 * Make a request to the GPS API using the correct signature algorithm
 */
async function makeRequest(
  endpoint: string,
  data: Record<string, unknown>
): Promise<{ status: number; body: unknown; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Use the CORRECT generateAuthCode from gps.ts (sorted keys algorithm)
  const authCode = generateAuthCode(data, timestamp, API_KEY, API_SECRET);

  const requestBody = {
    appKey: API_KEY,
    data,
    reqTime: timestamp,
  };

  const url = `${BASE_URL}${endpoint}?authcode=${authCode}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    return { status: response.status, body: parsed };
  } catch (error) {
    return {
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("GPS OMS API ENDPOINT DISCOVERY");
  console.log("=".repeat(70));
  console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  // List of endpoints to probe - these are common WMS/OMS patterns
  const endpointsToTry = [
    // Inventory endpoints
    { path: "/openapi/v1/inventory/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/inventory/query", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/inventory/getList", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/stock/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/stock/query", data: { page: 1, pageSize: 10 } },

    // Product endpoints
    { path: "/openapi/v1/product/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/product/query", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/product/getList", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/sku/list", data: { page: 1, pageSize: 10 } },

    // Warehouse endpoints
    { path: "/openapi/v1/warehouse/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/warehouse/query", data: {} },

    // Inbound/receiving endpoints
    { path: "/openapi/v1/inbound/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/inboundOrder/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/receiving/list", data: { page: 1, pageSize: 10 } },

    // Outbound/order endpoints (we know these work)
    { path: "/openapi/v1/outboundOrder/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/order/list", data: { page: 1, pageSize: 10 } },

    // Returns endpoints
    { path: "/openapi/v1/return/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/returnOrder/list", data: { page: 1, pageSize: 10 } },

    // FBA endpoints (common in Lingxing)
    { path: "/openapi/v1/fba/inventory", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v1/fba/shipment/list", data: { page: 1, pageSize: 10 } },

    // General query endpoints
    { path: "/openapi/v1/data/list", data: { type: "inventory", page: 1, pageSize: 10 } },
    { path: "/openapi/v1/api/list", data: {} },

    // V2 endpoints (in case they have a newer API version)
    { path: "/openapi/v2/inventory/list", data: { page: 1, pageSize: 10 } },
    { path: "/openapi/v2/product/list", data: { page: 1, pageSize: 10 } },
  ];

  const workingEndpoints: string[] = [];
  const potentialEndpoints: string[] = [];

  for (const { path, data } of endpointsToTry) {
    process.stdout.write(`Testing ${path.padEnd(40)} ... `);

    const result = await makeRequest(path, data);

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      continue;
    }

    const body = result.body as Record<string, unknown>;

    // Check for success indicators
    if (result.status === 200) {
      if (body.code === 0 || body.code === 200 || body.success === true) {
        console.log(`✅ SUCCESS - ${JSON.stringify(body).slice(0, 80)}...`);
        workingEndpoints.push(path);
      } else if (
        body.code === 1001 ||
        body.code === 1002 ||
        body.msg?.toString().includes("参数")
      ) {
        // Parameter error - endpoint exists but we're calling it wrong
        console.log(`⚠️  EXISTS (param error) - ${body.msg || body.message}`);
        potentialEndpoints.push(path);
      } else if (body.code === 403 || body.code === 401 || body.msg?.toString().includes("权限")) {
        // Permission denied - endpoint exists but not authorized
        console.log(`🔒 EXISTS (no access) - ${body.msg || body.message}`);
        potentialEndpoints.push(path);
      } else {
        console.log(
          `❌ ${result.status} - code: ${body.code}, msg: ${body.msg || body.message || "unknown"}`
        );
      }
    } else if (result.status === 404) {
      console.log(`❌ 404 Not Found`);
    } else {
      console.log(`❌ ${result.status} - ${JSON.stringify(body).slice(0, 60)}`);
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log();
  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));

  if (workingEndpoints.length > 0) {
    console.log("\n✅ WORKING ENDPOINTS:");
    for (const ep of workingEndpoints) {
      console.log(`   ${ep}`);
    }
  }

  if (potentialEndpoints.length > 0) {
    console.log("\n⚠️  POTENTIAL ENDPOINTS (exist but need correct params or permissions):");
    for (const ep of potentialEndpoints) {
      console.log(`   ${ep}`);
    }
  }

  if (workingEndpoints.length === 0 && potentialEndpoints.length === 0) {
    console.log("\n❌ No inventory/product endpoints found.");
    console.log("   The API only supports outbound order management.");
  }

  console.log();
}

main().catch(console.error);
