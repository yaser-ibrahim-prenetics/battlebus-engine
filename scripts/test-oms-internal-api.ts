/**
 * Test OMS Internal API (same endpoints the web portal uses)
 * 
 * This uses the JWT Bearer token from your logged-in OMS session
 * to access inventory data directly.
 * 
 * Run with: npx tsx scripts/test-oms-internal-api.ts
 */

// Your JWT token from the browser session (from the Authorization header you shared)
const JWT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIlN0IlMjJidXNpbmVzc1R5cGUlMjIlM0ElMjJvbXMlMjIlMkMlMjJsb2dpbkFjY291bnQlMjIlM0ElMjJJTTgtVUstVEVTVCUyMiUyQyUyMnVzZXJOYW1lQ24lMjIlM0ElMjIlMjIlMkMlMjJ1c2VyTmFtZUVuJTIyJTNBJTIyJTIyJTJDJTIyY3VzdG9tZXJDb2RlJTIyJTNBJTIyMTA4MjIyNiUyMiUyQyUyMnRlbmFudENvZGUlMjIlM0FudWxsJTJDJTIydGVybWluYWxUeXBlJTIyJTNBbnVsbCU3RCIsImlzcyI6InhpbmdsaWFuLnNlY3VyaXR5IiwiYnVzaW5lc3NUeXBlIjoib21zIiwiZXhwIjoxNzcwMzUxNTM5LCJpYXQiOjE3NzAyNjUxMzksImp0aSI6ImE5MTk0MGY0LTMwNzUtNDZjNC1iZDcyLTc3ZjAyYjFjYzA4MCJ9.a1VB0ZTMVD9r5n4mL1-Ap0KpGd1U7aoibMKzd-M7LDk";

const BASE_URL = "https://oms.xlwms.com";

async function makeRequest(endpoint: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`\n${method} ${url}`);
  
  const options: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${JWT_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
      "lang": "en",
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return { status: response.status, data };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("OMS INTERNAL API TEST (Using JWT Session Token)");
  console.log("=".repeat(70));
  
  // Decode JWT to see what's in it
  const [, payloadB64] = JWT_TOKEN.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  console.log("\nJWT Payload:");
  console.log("  Expiry:", new Date(payload.exp * 1000).toISOString());
  console.log("  Issued:", new Date(payload.iat * 1000).toISOString());
  
  // Decode the sub field (it's URL encoded JSON)
  const subData = JSON.parse(decodeURIComponent(payload.sub));
  console.log("  Account:", subData.loginAccount);
  console.log("  Customer Code:", subData.customerCode);
  console.log("  Business Type:", subData.businessType);
  
  // Check if token is expired
  if (Date.now() > payload.exp * 1000) {
    console.log("\n⚠️  WARNING: JWT token has EXPIRED! You need to get a fresh one from the browser.");
    console.log("   Token expired at:", new Date(payload.exp * 1000).toISOString());
    return;
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("TESTING INVENTORY ENDPOINTS");
  console.log("=".repeat(70));
  
  // These are potential internal endpoints based on the OMS web structure
  const endpoints = [
    // Stock/Inventory endpoints (based on your referer showing /report/stock)
    { path: "/gateway/woms/report/stock/list", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/report/stock/query", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/inventory/list", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/inventory/query", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/stock/list", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/stock/query", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    
    // The endpoint you showed - platform stores
    { path: "/gateway/woms/platform/store/selectPlatformStores", method: "GET" as const },
    
    // Product/SKU endpoints
    { path: "/gateway/woms/product/list", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    { path: "/gateway/woms/sku/list", method: "POST" as const, body: { page: 1, pageSize: 10 } },
    
    // Warehouse endpoints
    { path: "/gateway/woms/warehouse/list", method: "GET" as const },
    { path: "/gateway/woms/warehouse/query", method: "GET" as const },
  ];
  
  for (const ep of endpoints) {
    const result = await makeRequest(ep.path, ep.method, ep.body);
    
    if (result.status === 200 && result.data) {
      const dataStr = JSON.stringify(result.data);
      if (dataStr.length > 200) {
        console.log(`✅ ${result.status} - ${dataStr.slice(0, 200)}...`);
      } else {
        console.log(`✅ ${result.status} - ${dataStr}`);
      }
      
      // If we got data, show more details
      if (result.data.data && Array.isArray(result.data.data) && result.data.data.length > 0) {
        console.log(`   📦 Found ${result.data.data.length} items!`);
        console.log(`   Sample:`, JSON.stringify(result.data.data[0], null, 2).slice(0, 300));
      }
    } else if (result.status === 401) {
      console.log(`❌ ${result.status} - Unauthorized (token expired or invalid)`);
    } else if (result.status === 404) {
      console.log(`⚪ ${result.status} - Not found`);
    } else {
      console.log(`❌ ${result.status} - ${JSON.stringify(result.data || result.error).slice(0, 100)}`);
    }
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("DONE");
  console.log("=".repeat(70));
}

main().catch(console.error);
