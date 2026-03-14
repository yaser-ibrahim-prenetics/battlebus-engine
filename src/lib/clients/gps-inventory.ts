// ============================================================================
// GPS INVENTORY API CLIENT
// ============================================================================
// Implements Lingxing OMS API for querying GPS warehouse inventory
// Uses the same authentication as the GPS order API (appKey/appSecret + HMAC SHA256)
//
// Based on: oms.xlwms.com API documentation
// Your credentials from OMS portal can be used for both orders AND inventory
//
// Key Endpoints:
//   - Inventory queries via OMS API
//   - Uses same HMAC SHA256 auth as order API

import crypto from "crypto";
import { config } from "../config";

// Client-side pacing for OMS API calls (adds protection beyond function-level throttle).
const OMS_MIN_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.OMS_CLIENT_MIN_INTERVAL_MS || "120", 10)
);
const OMS_MAX_PAGE_SIZE = Math.max(1, parseInt(process.env.OMS_MAX_INVENTORY_PAGE_SIZE || "100", 10));
const OMS_MAX_SKU_LIST_SIZE = Math.max(1, parseInt(process.env.OMS_MAX_PRODUCT_SKU_LIST_SIZE || "50", 10));
let omsLastRequestAt = 0;

async function pacedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  if (OMS_MIN_INTERVAL_MS > 0) {
    const now = Date.now();
    const waitMs = Math.max(0, omsLastRequestAt + OMS_MIN_INTERVAL_MS - now);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    omsLastRequestAt = Date.now();
  }
  return fetch(input, init);
}

// ============================================================================
// TYPES
// ============================================================================

export interface GpsWarehouseInfo {
  warehouse_id: number;
  warehouse_type: number; // 1: local, 3: overseas
  warehouse_name: string;
  warehouse_country_code: string;
  provider_id?: number;
  provider_name?: string;
  third_party_warehouse_code?: string;
  deleted: number; // 0: not deleted, 1: deleted
}

export interface GpsInventoryItem {
  sku: string;
  productName?: string;
  warehouseCode: string;
  warehouseName?: string;
  availableQty: number; // 可用库存
  reservedQty: number; // 锁定库存
  inTransitQty: number; // 在途库存
  pendingQcQty: number; // 待检库存
  totalQty: number; // 总库存
  lastUpdated?: string;
}

export interface GpsInventoryResponse {
  code: number;
  msg: string;
  data: {
    list?: GpsInventoryItem[];
    page?: number;
    pageSize?: number;
    total?: number;
  };
}

export interface GpsProductInventoryItem {
  sku: string;
  productSku?: string;
  warehouseCode: string;
  qty: number;
  availableQty: number;
  lockedQty: number;
  transitQty: number;
  defectiveQty: number;
}

// ============================================================================
// AUTHENTICATION (Same as GPS Order API)
// ============================================================================

/**
 * Generate HMAC SHA256 authcode for GPS OMS API
 * Same mechanism as the order API
 */
function generateAuthCode(
  appKey: string,
  appSecret: string,
  timestamp: string,
  data: Record<string, unknown>
): string {
  const dataStr = JSON.stringify(data);
  const signStr = `${appKey}${timestamp}${dataStr}${appSecret}`;
  return crypto.createHmac("sha256", appSecret).update(signStr).digest("hex");
}

/**
 * Get GPS credentials for a specific warehouse region
 */
function getCredentials(region: "US" | "UK" = "UK"): {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  warehouseCode: string;
} {
  if (region === "UK") {
    return {
      baseUrl: config.gpsUk.baseUrl,
      apiKey: config.gpsUk.apiKey,
      apiSecret: config.gpsUk.apiSecret,
      warehouseCode: config.gpsUk.warehouseCode,
    };
  }
  return {
    baseUrl: config.gps.baseUrl,
    apiKey: config.gps.apiKey,
    apiSecret: config.gps.apiSecret,
    warehouseCode: config.gps.warehouseCode,
  };
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Query GPS inventory via OMS API
 * Uses the same auth mechanism as order creation
 *
 * @param region - Which GPS region to query (US or UK)
 * @param sku - Optional SKU filter
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 */
export async function queryOmsInventory(options: {
  region?: "US" | "UK";
  sku?: string;
  page?: number;
  pageSize?: number;
}): Promise<GpsProductInventoryItem[]> {
  const { region = "UK", sku, page = 1, pageSize = 100 } = options;
  const creds = getCredentials(region);

  console.log(`[GPS-Inventory] Querying OMS inventory (region=${region}, sku=${sku || "all"})`);

  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Request data structure based on OMS API pattern
  const data: Record<string, unknown> = {
    page,
    pageSize: Math.min(OMS_MAX_PAGE_SIZE, Math.max(1, pageSize)),
    warehouseCode: creds.warehouseCode,
  };

  if (sku) {
    data.sku = sku;
  }

  const authCode = generateAuthCode(creds.apiKey, creds.apiSecret, timestamp, data);

  const requestBody = {
    appKey: creds.apiKey,
    data,
    reqTime: timestamp,
  };

  // Try inventory query endpoint
  // Note: The actual endpoint path may need adjustment based on OMS documentation
  const inventoryEndpoints = [
    "/openapi/v1/inventory/query",
    "/openapi/v1/product/inventory",
    "/openapi/v1/stock/list",
  ];

  for (const endpoint of inventoryEndpoints) {
    try {
      const url = `${creds.baseUrl}${endpoint}?authcode=${authCode}`;
      console.log(`[GPS-Inventory] Trying endpoint: ${endpoint}`);

      const response = await pacedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(
          `[GPS-Inventory] Endpoint ${endpoint} returned ${response.status}: ${errorText}`
        );
        continue;
      }

      const result = await response.json();

      if (result.code === 0 || result.code === 200 || result.success) {
        console.log(`[GPS-Inventory] Successfully queried via ${endpoint}`);
        return result.data?.list || result.data || [];
      }

      console.log(`[GPS-Inventory] Endpoint ${endpoint} error: ${result.msg || result.message}`);
    } catch (error) {
      console.log(`[GPS-Inventory] Endpoint ${endpoint} failed: ${error}`);
    }
  }

  console.warn("[GPS-Inventory] No inventory endpoints responded successfully");
  console.warn("[GPS-Inventory] This may mean inventory API is not available on this account");
  return [];
}

/**
 * Get product inventory from GPS OMS
 * Alternative approach using product details endpoint
 */
export async function queryProductInventory(options: {
  region?: "US" | "UK";
  skus?: string[];
}): Promise<GpsProductInventoryItem[]> {
  const { region = "UK", skus = [] } = options;
  const creds = getCredentials(region);

  console.log(`[GPS-Inventory] Querying product inventory (region=${region}, skus=${skus.length})`);

  if (skus.length === 0) {
    console.log("[GPS-Inventory] No SKUs provided, querying all");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();

  const skuChunks =
    skus.length > 0
      ? Array.from({ length: Math.ceil(skus.length / OMS_MAX_SKU_LIST_SIZE) }, (_, i) =>
          skus.slice(i * OMS_MAX_SKU_LIST_SIZE, (i + 1) * OMS_MAX_SKU_LIST_SIZE)
        )
      : [[]];

  const allProducts: GpsProductInventoryItem[] = [];
  for (const skuChunk of skuChunks) {
    const data: Record<string, unknown> = {
      page: 1,
      pageSize: OMS_MAX_PAGE_SIZE,
      warehouseCode: creds.warehouseCode,
    };
    if (skuChunk.length > 0) {
      data.skuList = skuChunk;
    }

    const authCode = generateAuthCode(creds.apiKey, creds.apiSecret, timestamp, data);
    const requestBody = {
      appKey: creds.apiKey,
      data,
      reqTime: timestamp,
    };
    const url = `${creds.baseUrl}/openapi/v1/product/list?authcode=${authCode}`;

    try {
      const response = await pacedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Product list failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (result.code !== 0 && result.code !== 200) {
        throw new Error(`Product list error: ${result.msg || result.message}`);
      }

      const products = result.data?.list || result.data || [];
      allProducts.push(
        ...products.map((p: Record<string, unknown>) => ({
          sku: p.sku || p.productSku,
          productSku: p.productSku,
          warehouseCode: creds.warehouseCode,
          qty: p.qty || p.quantity || 0,
          availableQty: p.availableQty || p.available || 0,
          lockedQty: p.lockedQty || p.locked || 0,
          transitQty: p.transitQty || p.inTransit || 0,
          defectiveQty: p.defectiveQty || p.defective || 0,
        }))
      );
    } catch (error) {
      console.error("[GPS-Inventory] Product inventory query failed:", error);
    }
  }
  return allProducts;
}

/**
 * Query inventory by calculating from outbound order history
 * Fallback approach when direct inventory API is not available
 */
export async function estimateInventoryFromOrders(options: {
  region?: "US" | "UK";
  skus?: string[];
  daysBack?: number;
}): Promise<Map<string, number>> {
  const { region = "UK", skus = [], daysBack = 30 } = options;
  const creds = getCredentials(region);

  console.log(`[GPS-Inventory] Estimating inventory from order history (region=${region})`);

  // This is a placeholder - actual implementation would:
  // 1. Query completed outbound orders for the last N days
  // 2. Sum up quantities shipped per SKU
  // 3. Compare against expected inventory or initial stock levels

  // For now, return empty map as this requires integration with order history
  console.log("[GPS-Inventory] Order-based estimation not yet implemented");
  return new Map();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get inventory for a specific SKU across all GPS regions
 */
export async function getSkuInventory(sku: string): Promise<{
  sku: string;
  totalAvailable: number;
  totalReserved: number;
  totalInTransit: number;
  warehouses: Array<{
    region: string;
    warehouseCode: string;
    available: number;
    reserved: number;
    inTransit: number;
  }>;
}> {
  console.log(`[GPS-Inventory] Getting inventory for SKU: ${sku}`);

  const warehouses: Array<{
    region: string;
    warehouseCode: string;
    available: number;
    reserved: number;
    inTransit: number;
  }> = [];

  let totalAvailable = 0;
  let totalReserved = 0;
  let totalInTransit = 0;

  // Query both US and UK regions
  for (const region of ["US", "UK"] as const) {
    try {
      const items = await queryOmsInventory({ region, sku });

      for (const item of items) {
        const available = item.availableQty || 0;
        const reserved = item.lockedQty || 0;
        const inTransit = item.transitQty || 0;

        warehouses.push({
          region,
          warehouseCode: item.warehouseCode,
          available,
          reserved,
          inTransit,
        });

        totalAvailable += available;
        totalReserved += reserved;
        totalInTransit += inTransit;
      }
    } catch (error) {
      console.error(`[GPS-Inventory] Failed to query ${region}:`, error);
    }
  }

  return {
    sku,
    totalAvailable,
    totalReserved,
    totalInTransit,
    warehouses,
  };
}

/**
 * Get inventory snapshot for multiple SKUs
 * Optimized for batch queries
 */
export async function getInventorySnapshot(
  skus: string[],
  region: "US" | "UK" = "UK"
): Promise<
  Map<
    string,
    {
      available: number;
      reserved: number;
      inTransit: number;
    }
  >
> {
  console.log(`[GPS-Inventory] Getting inventory snapshot for ${skus.length} SKUs`);

  const snapshot = new Map<
    string,
    {
      available: number;
      reserved: number;
      inTransit: number;
    }
  >();

  // Initialize all requested SKUs with zero
  for (const sku of skus) {
    snapshot.set(sku, { available: 0, reserved: 0, inTransit: 0 });
  }

  try {
    // Query product inventory for the region
    const items = await queryProductInventory({ region, skus });

    // Aggregate inventory by SKU
    for (const item of items) {
      const sku = item.sku;
      if (!skus.includes(sku)) continue;

      const current = snapshot.get(sku) || { available: 0, reserved: 0, inTransit: 0 };
      snapshot.set(sku, {
        available: current.available + (item.availableQty || 0),
        reserved: current.reserved + (item.lockedQty || 0),
        inTransit: current.inTransit + (item.transitQty || 0),
      });
    }
  } catch (error) {
    console.error("[GPS-Inventory] Snapshot query failed:", error);
  }

  console.log(`[GPS-Inventory] Snapshot contains ${snapshot.size} SKUs`);
  return snapshot;
}

/**
 * Test GPS inventory API connectivity
 * Useful for debugging and verifying credentials
 */
export async function testInventoryConnection(region: "US" | "UK" = "UK"): Promise<{
  success: boolean;
  message: string;
  availableEndpoints?: string[];
}> {
  console.log(`[GPS-Inventory] Testing connection for region: ${region}`);

  const creds = getCredentials(region);
  const availableEndpoints: string[] = [];

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const data = { page: 1, pageSize: 1 };
  const authCode = generateAuthCode(creds.apiKey, creds.apiSecret, timestamp, data);

  const requestBody = {
    appKey: creds.apiKey,
    data,
    reqTime: timestamp,
  };

  // Test various endpoints
  const testEndpoints = [
    "/openapi/v1/inventory/query",
    "/openapi/v1/product/list",
    "/openapi/v1/stock/list",
    "/openapi/v1/product/inventory",
  ];

  for (const endpoint of testEndpoints) {
    try {
      const url = `${creds.baseUrl}${endpoint}?authcode=${authCode}`;

      const response = await pacedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.code === 0 || result.code === 200 || result.success) {
          availableEndpoints.push(endpoint);
        }
      }
    } catch (error) {
      // Endpoint not available
    }
  }

  if (availableEndpoints.length > 0) {
    return {
      success: true,
      message: `Found ${availableEndpoints.length} working endpoint(s)`,
      availableEndpoints,
    };
  }

  return {
    success: false,
    message:
      "No inventory endpoints available. Your GPS account may only support order management. Contact GPS support to enable inventory API access.",
  };
}
