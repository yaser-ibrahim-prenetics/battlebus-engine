/**
 * EXHAUSTIVE GPS API ENDPOINT TEST
 * 
 * Tests every possible endpoint to find what we have access to
 * beyond just outbound orders.
 * 
 * Run with: npx tsx scripts/exhaustive-gps-endpoint-test.ts
 */

import { generateAuthCode } from "@/lib/clients/gps";
import { config } from "@/lib/config";

const API_KEY = config.gpsUk.apiKey;
const API_SECRET = config.gpsUk.apiSecret;
const BASE_URL = config.gpsUk.baseUrl;

interface TestResult {
  endpoint: string;
  code: number | string;
  message: string;
  hasData: boolean;
  dataPreview?: string;
}

async function testEndpoint(
  endpoint: string,
  data: Record<string, unknown>
): Promise<TestResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const authCode = generateAuthCode(data, timestamp, API_KEY, API_SECRET);

  const requestBody = {
    appKey: API_KEY,
    data,
    reqTime: timestamp,
  };

  try {
    const response = await fetch(`${BASE_URL}${endpoint}?authcode=${authCode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();
    const hasData = result.data && (
      (Array.isArray(result.data) && result.data.length > 0) ||
      (typeof result.data === "object" && Object.keys(result.data).length > 0)
    );

    return {
      endpoint,
      code: result.code,
      message: result.msg || result.message || "",
      hasData,
      dataPreview: hasData ? JSON.stringify(result.data).slice(0, 150) : undefined,
    };
  } catch (error) {
    return {
      endpoint,
      code: "ERROR",
      message: String(error),
      hasData: false,
    };
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("EXHAUSTIVE GPS API ENDPOINT TEST");
  console.log("=".repeat(80));
  console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  // Comprehensive list of potential endpoints based on WMS/OMS patterns
  const endpoints: { path: string; data: Record<string, unknown>; description: string }[] = [
    // ==================== OUTBOUND ORDER (Known Working) ====================
    { path: "/openapi/v1/outboundOrder/create", data: [], description: "Create outbound order" },
    { path: "/openapi/v1/outboundOrder/detail", data: { outboundOrderNoList: [] }, description: "Get outbound order details" },
    { path: "/openapi/v1/outboundOrder/list", data: { page: 1, pageSize: 10 }, description: "List outbound orders" },
    { path: "/openapi/v1/outboundOrder/cancel", data: { orderNo: "TEST" }, description: "Cancel outbound order" },
    { path: "/openapi/v1/outboundOrder/query", data: { page: 1, pageSize: 10 }, description: "Query outbound orders" },
    { path: "/openapi/v1/outboundOrder/status", data: { orderNoList: [] }, description: "Get order status" },
    { path: "/openapi/v1/outboundOrder/tracking", data: { orderNo: "TEST" }, description: "Get tracking info" },
    
    // ==================== INBOUND ORDER ====================
    { path: "/openapi/v1/inboundOrder/create", data: [], description: "Create inbound order" },
    { path: "/openapi/v1/inboundOrder/detail", data: { inboundOrderNoList: [] }, description: "Get inbound order details" },
    { path: "/openapi/v1/inboundOrder/list", data: { page: 1, pageSize: 10 }, description: "List inbound orders" },
    { path: "/openapi/v1/inboundOrder/query", data: { page: 1, pageSize: 10 }, description: "Query inbound orders" },
    
    // ==================== INVENTORY ====================
    { path: "/openapi/v1/inventory/list", data: { page: 1, pageSize: 10 }, description: "List inventory" },
    { path: "/openapi/v1/inventory/query", data: { page: 1, pageSize: 10 }, description: "Query inventory" },
    { path: "/openapi/v1/inventory/detail", data: { skuList: [] }, description: "Get inventory details" },
    { path: "/openapi/v1/inventory/snapshot", data: { page: 1, pageSize: 10 }, description: "Inventory snapshot" },
    { path: "/openapi/v1/inventory/history", data: { page: 1, pageSize: 10 }, description: "Inventory history" },
    { path: "/openapi/v1/inventory/adjust", data: {}, description: "Adjust inventory" },
    
    // ==================== STOCK ====================
    { path: "/openapi/v1/stock/list", data: { page: 1, pageSize: 10 }, description: "List stock" },
    { path: "/openapi/v1/stock/query", data: { page: 1, pageSize: 10 }, description: "Query stock" },
    { path: "/openapi/v1/stock/detail", data: { skuList: [] }, description: "Stock details" },
    { path: "/openapi/v1/stock/summary", data: {}, description: "Stock summary" },
    
    // ==================== PRODUCT/SKU ====================
    { path: "/openapi/v1/product/list", data: { page: 1, pageSize: 10 }, description: "List products" },
    { path: "/openapi/v1/product/detail", data: { skuList: [] }, description: "Product details" },
    { path: "/openapi/v1/product/create", data: [], description: "Create product" },
    { path: "/openapi/v1/product/query", data: { page: 1, pageSize: 10 }, description: "Query products" },
    { path: "/openapi/v1/sku/list", data: { page: 1, pageSize: 10 }, description: "List SKUs" },
    { path: "/openapi/v1/sku/detail", data: { skuList: [] }, description: "SKU details" },
    { path: "/openapi/v1/sku/query", data: { page: 1, pageSize: 10 }, description: "Query SKUs" },
    
    // ==================== WAREHOUSE ====================
    { path: "/openapi/v1/warehouse/list", data: {}, description: "List warehouses" },
    { path: "/openapi/v1/warehouse/query", data: {}, description: "Query warehouses" },
    { path: "/openapi/v1/warehouse/detail", data: { whCode: "LHR" }, description: "Warehouse details" },
    
    // ==================== SHIPMENT/LOGISTICS ====================
    { path: "/openapi/v1/shipment/list", data: { page: 1, pageSize: 10 }, description: "List shipments" },
    { path: "/openapi/v1/shipment/detail", data: { shipmentNoList: [] }, description: "Shipment details" },
    { path: "/openapi/v1/shipment/tracking", data: { trackingNo: "TEST" }, description: "Shipment tracking" },
    { path: "/openapi/v1/logistics/list", data: {}, description: "List logistics channels" },
    { path: "/openapi/v1/logistics/query", data: {}, description: "Query logistics" },
    { path: "/openapi/v1/carrier/list", data: {}, description: "List carriers" },
    
    // ==================== RETURN ====================
    { path: "/openapi/v1/return/list", data: { page: 1, pageSize: 10 }, description: "List returns" },
    { path: "/openapi/v1/return/create", data: [], description: "Create return" },
    { path: "/openapi/v1/return/detail", data: { returnOrderNoList: [] }, description: "Return details" },
    { path: "/openapi/v1/returnOrder/list", data: { page: 1, pageSize: 10 }, description: "List return orders" },
    
    // ==================== FBA ====================
    { path: "/openapi/v1/fba/inventory", data: { page: 1, pageSize: 10 }, description: "FBA inventory" },
    { path: "/openapi/v1/fba/shipment/list", data: { page: 1, pageSize: 10 }, description: "FBA shipments" },
    { path: "/openapi/v1/fba/shipment/create", data: [], description: "Create FBA shipment" },
    
    // ==================== TRANSFER ====================
    { path: "/openapi/v1/transfer/list", data: { page: 1, pageSize: 10 }, description: "List transfers" },
    { path: "/openapi/v1/transfer/create", data: [], description: "Create transfer" },
    
    // ==================== REPORT ====================
    { path: "/openapi/v1/report/inventory", data: { page: 1, pageSize: 10 }, description: "Inventory report" },
    { path: "/openapi/v1/report/stock", data: { page: 1, pageSize: 10 }, description: "Stock report" },
    { path: "/openapi/v1/report/outbound", data: { page: 1, pageSize: 10 }, description: "Outbound report" },
    
    // ==================== MISC ====================
    { path: "/openapi/v1/order/list", data: { page: 1, pageSize: 10 }, description: "List orders (generic)" },
    { path: "/openapi/v1/order/detail", data: { orderNoList: [] }, description: "Order details (generic)" },
    { path: "/openapi/v1/data/list", data: { page: 1, pageSize: 10 }, description: "List data" },
    { path: "/openapi/v1/api/list", data: {}, description: "List available APIs" },
    { path: "/openapi/v1/system/info", data: {}, description: "System info" },
  ];

  const results: TestResult[] = [];
  const hasAccess: TestResult[] = [];
  const noPermission: TestResult[] = [];
  const paramError: TestResult[] = [];
  const notFound: TestResult[] = [];

  for (const ep of endpoints) {
    process.stdout.write(`Testing ${ep.path.padEnd(45)} ... `);
    const result = await testEndpoint(ep.path, ep.data);
    results.push(result);

    const code = Number(result.code);
    if (code === 200 || code === 0) {
      console.log(`✅ ${result.code} - ${result.message}`);
      hasAccess.push(result);
    } else if (code === 11008) {
      console.log(`🔒 NO PERMISSION`);
      noPermission.push(result);
    } else if (code === 400 || code === 1001 || code === 1002) {
      console.log(`⚠️  PARAM ERROR (endpoint exists!) - ${result.message.slice(0, 50)}`);
      paramError.push(result);
    } else if (code === 404 || code === 11001) {
      console.log(`⚪ NOT FOUND`);
      notFound.push(result);
    } else {
      console.log(`❓ ${result.code} - ${result.message.slice(0, 50)}`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  console.log(`\n✅ HAS ACCESS (${hasAccess.length}):`);
  for (const r of hasAccess) {
    console.log(`   ${r.endpoint}`);
    if (r.dataPreview) console.log(`      Data: ${r.dataPreview}`);
  }

  console.log(`\n⚠️  PARAM ERROR - Endpoint EXISTS, we might have access (${paramError.length}):`);
  for (const r of paramError) {
    console.log(`   ${r.endpoint} - ${r.message.slice(0, 60)}`);
  }

  console.log(`\n🔒 NO PERMISSION (${noPermission.length}):`);
  console.log(`   ${noPermission.map(r => r.endpoint.replace("/openapi/v1/", "")).join(", ")}`);

  console.log(`\n⚪ NOT FOUND (${notFound.length}):`);
  console.log(`   ${notFound.map(r => r.endpoint.replace("/openapi/v1/", "")).join(", ")}`);

  // Final verdict
  console.log("\n" + "=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  
  if (hasAccess.length === 0 && paramError.length === 0) {
    console.log("\n❌ Only outbound order endpoints are accessible.");
    console.log("   Your API credentials don't have inventory/product permissions.");
    console.log("   Contact GPS support to request inventory API access.");
  } else {
    console.log(`\n✅ Found ${hasAccess.length + paramError.length} accessible endpoints!`);
  }
}

main().catch(console.error);
