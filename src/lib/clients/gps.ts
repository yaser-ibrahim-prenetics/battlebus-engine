// ============================================================================
// GPS WAREHOUSE API CLIENT
// ============================================================================
// Ported from spock-store src/component/integration/gps.ts
// Uses correct GPS auth code algorithm with sorted keys

import crypto from "crypto";
import { config, GPS_STATUS } from "../config";
import type { GpsOutboundOrder, GpsFulfilmentNotification } from "../types/gps";
import warehouseConfig from "../mappings/warehouse-config.json";
import { gpsSimulationStore } from "../stores/gps-simulation";

// ============================================================================
// GPS AUTH CODE GENERATION (Ported from spock-store)
// ============================================================================

/**
 * Recursively sorts the keys of an object or array to maintain consistency when generating hash.
 * This is CRITICAL for GPS API authentication.
 */
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

/**
 * Generate SHA256 HMAC signature
 */
function sha256Hmac(message: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Generate GPS auth code using the correct algorithm from spock-store
 * GPS uses sorted keys concatenation, NOT simple message hashing
 */
export function generateAuthCode(
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
    if (["authcode", "appkey", "appsecret", "reqtime"].includes(lowerKey))
      continue;

    if (key === "data") {
      dataMap[lowerKey] = deepSortKeys(value);
    } else {
      dataMap[lowerKey] = value;
    }
  }

  const sortedKeys = Object.keys(dataMap).sort();
  let concatenatedStr = "";

  for (const key of sortedKeys) {
    const val =
      typeof dataMap[key] === "string"
        ? dataMap[key]
        : JSON.stringify(dataMap[key]);
    concatenatedStr += val;
  }

  return sha256Hmac(concatenatedStr, appSecret);
}

// ============================================================================
// GPS API TYPES
// ============================================================================

export interface GpsOrderData {
  platformOrderNo: string;
  thirdOrderNo?: string;
  whCode: string;
  subOrderType: number;
  logisticsChannel: string;
  receiver: string;
  addressOne: string;
  addressTwo?: string;
  cityName: string;
  countryRegionCode: string;
  provinceName?: string;
  provinceCode?: string;
  postCode: string;
  telephone?: string;
  email?: string;
  productList: GpsProductItem[];
}

export interface GpsProductItem {
  sku: string;
  quantity: number;
}

export interface GpsCreateOrderRequest {
  data: GpsOrderData[];
  appKey: string;
  reqTime: string;
}

export interface GpsCreateOrderResponse {
  code: number;
  msg: string;
  data: {
    success: boolean;
    orderNo: string;
    thirdOrderNo: string;
    msg: string;
  }[];
}

export interface GpsGetOrdersDetailRequest {
  appKey: string;
  reqTime: string;
  data: {
    outboundOrderNoList: string[];
  };
}

export interface GpsGetOrdersDetailResponse {
  code: number;
  msg: string;
  data: {
    outboundOrderNo: string;
    status: number;
    logisticsTrackNo: string;
    logisticsCarrier: string;
    platformOrderNo: string;
    outboundTime: string;
  }[];
}

// GPS Order Type constants
export const GpsOrderType = {
  PRODUCT_OUTBOUND: 1,
  SAMPLE_OUTBOUND: 2,
  RETURN_OUTBOUND: 3,
} as const;

// ============================================================================
// GPS API FUNCTIONS
// ============================================================================

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

function getWarehouseConfig(warehouseName: GpsWarehouseName) {
  const warehouse = warehouseConfig.warehouses[warehouseName];
  if (!warehouse) {
    throw new Error(`GPS warehouse configuration not found: ${warehouseName}`);
  }
  return warehouse;
}

function getApiCredentials(warehouseName: GpsWarehouseName) {
  if (warehouseName === "GPS UK Warehouse") {
    // If GPS UK credentials are not explicitly set, fallback to main GPS credentials?
    // Or assume config validation ensures they are set if needed.
    // config.gpsUk defaults to gps if not set, but let's be explicit.
    return {
      appKey: config.gpsUk.apiKey || config.gps.apiKey,
      appSecret: config.gpsUk.apiSecret || config.gps.apiSecret,
      baseUrl: config.gpsUk.baseUrl || config.gps.baseUrl,
    };
  }
  return {
    appKey: config.gps.apiKey,
    appSecret: config.gps.apiSecret,
    baseUrl: config.gps.baseUrl,
  };
}

function epochInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create an Outbound Order in GPS Warehouse
 * Ported from spock-store with correct auth code generation
 */
export async function createOutboundOrder(
  orderData: GpsOrderData,
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<{
  response: GpsCreateOrderResponse;
  request: GpsCreateOrderRequest;
}> {
  // Validate warehouse exists
  getWarehouseConfig(warehouseName);
  const { appKey, appSecret, baseUrl } = getApiCredentials(warehouseName);

  const data: GpsOrderData[] = [orderData];
  const timestamp = epochInSeconds().toString();

  const payload: GpsCreateOrderRequest = {
    data,
    appKey,
    reqTime: timestamp,
  };

  console.log(`[GPS] Creating outbound order: ${JSON.stringify(payload)}`);

  if (config.features.dryRunMode) {
    console.log(
      `[GPS] DRY RUN - Would create order for ${orderData.platformOrderNo}`
    );
    return {
      response: {
        code: 200,
        msg: "DRY RUN SUCCESS",
        data: [
          {
            success: true,
            orderNo: `DRY-RUN-${Date.now()}`,
            thirdOrderNo: orderData.thirdOrderNo || "",
            msg: "成功",
          },
        ],
      },
      request: payload,
    };
  }

  const authCode = generateAuthCode(data, timestamp, appKey, appSecret);

  const response = await fetch(
    `${baseUrl}/openapi/v1/outboundOrder/create?authcode=${authCode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const result: GpsCreateOrderResponse = await response.json();

  console.log(`[GPS] Response: ${JSON.stringify(result)}`);

  // Check for out of stock error
  // Note: GPS API returns Chinese error messages - 库存不足 means "insufficient inventory"
  if (result.code !== 200) {
    if (
      result.msg?.toLowerCase().includes("out of stock") ||
      result.msg?.toLowerCase().includes("insufficient") ||
      result.msg?.includes("库存不足")
    ) {
      throw new OutOfStockError(`GPS out of stock: ${result.msg}`);
    }
    throw new Error(`GPS API error: ${result.code} - ${result.msg}`);
  }

  // Check individual order result
  if (result.data?.[0] && !result.data[0].success) {
    const orderResult = result.data[0];
    if (
      orderResult.msg?.toLowerCase().includes("out of stock") ||
      orderResult.msg?.toLowerCase().includes("insufficient") ||
      orderResult.msg?.includes("库存不足")
    ) {
      throw new OutOfStockError(
        `GPS out of stock for ${orderData.platformOrderNo}: ${orderResult.msg}`
      );
    }
    throw new Error(`GPS order failed: ${orderResult.msg}`);
  }

  return { response: result, request: payload };
}

/**
 * Get Order Details from GPS
 */
export async function getOutboundOrdersDetails(
  orderIds: string[],
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<{ response: GpsGetOrdersDetailResponse }> {
  if (config.features.enabledGpsOutboundMock) {
    const mockData = await import('../mocks/gps/outboundOrders.json');
    console.log(`Using mock GPS outbound data for order ${orderIds}`);
    return {
      response: {
        code: 200,
        msg: '操作成功',
        data: mockData.default,
      },
    };
  }

  const { appKey, appSecret, baseUrl } = getApiCredentials(warehouseName);
  const timestamp = epochInSeconds().toString();

  const requestData = {
    outboundOrderNoList: orderIds,
  };

  const payload: GpsGetOrdersDetailRequest = {
    appKey,
    reqTime: timestamp,
    data: requestData,
  };

  console.log(`[GPS] Getting order details for: ${orderIds.join(", ")}`);

  // Check for simulated fulfillments (if simulation is enabled)
  // Note: Simulation store is keyed by platformOrderNo, so we'll check after getting the response

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would get order details`);
    return {
      response: {
        code: 200,
        msg: "DRY RUN SUCCESS",
        data: orderIds.map((id) => ({
          outboundOrderNo: id,
          status: 2,
          logisticsTrackNo: `DRY-TRACK-${Date.now()}`,
          logisticsCarrier: "DRY-CARRIER",
          platformOrderNo: `IM8-${Date.now()}`,
          outboundTime: new Date().toISOString(),
        })),
      },
    };
  }

  const authCode = generateAuthCode(requestData, timestamp, appKey, appSecret);

  const response = await fetch(
    `${baseUrl}/openapi/v1/outboundOrder/detail?authcode=${authCode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const result: GpsGetOrdersDetailResponse = await response.json();
  return { response: result };
}

/**
 * Cancel an Outbound Order in GPS
 */
export async function cancelOutboundOrder(
  orderNumber: string,
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<{ success: boolean; message: string }> {
  console.log(`[GPS] Cancelling order: ${orderNumber}`);

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would cancel order ${orderNumber}`);
    return { success: true, message: "DRY RUN - Order would be cancelled" };
  }

  // GPS cancel API - implementation depends on GPS API docs
  // For now, return a placeholder
  console.log(`[GPS] TODO: Implement GPS cancel API for ${orderNumber}`);
  return { success: false, message: "Cancel API not yet implemented" };
}

/**
 * Verify GPS Webhook Signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  const expectedSignature = sha256Hmac(
    `${timestamp}${payload}`,
    config.gps.apiSecret
  );
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

// Custom error for Out of Stock scenarios
export class OutOfStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfStockError";
  }
}

// ============================================================================
// INVENTORY QUERY
// ============================================================================

export interface GpsInventoryStockDetail {
  availableAmount: number;
  lockAmount: number;
  transportAmount: number;
}

export interface GpsInventoryItem {
  customerCode: string;
  whCode: string;
  whName: string;
  sku: string;
  skuId: string;
  stockType: number;
  totalAmount: number;
  productTotalAmount: number;
  boxTotalAmount: number;
  fbaReturnTotalAmount: number;
  productName: string;
  operateTime: string;
  productStockDtl: GpsInventoryStockDetail;
  boxStockDtl: GpsInventoryStockDetail;
  fbaReturnStockDtl: GpsInventoryStockDetail;
  productType: number;
}

export interface GpsGetInventoryRequest {
  appKey: string;
  reqTime: string;
  data: {
    pageNum: number;
    pageSize: number;
    sku?: string;
    whCode?: string;
  };
}

export interface GpsGetInventoryResponse {
  code: number;
  msg: string;
  data: {
    records: GpsInventoryItem[];
    total: number;
    page: number;
    pageSize: number;
    pages: number;
  };
}

/**
 * Fetch inventory from GPS warehouse system
 * Uses the /openapi/v1/integratedInventory/pageOpen endpoint
 */
export async function getInventory(
  options: {
    pageNum?: number;
    pageSize?: number;
    sku?: string;
    whCode?: string;
  } = {},
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<{ response: GpsGetInventoryResponse; items: GpsInventoryItem[] }> {
  const { appKey, appSecret, baseUrl } = getApiCredentials(warehouseName);
  const timestamp = epochInSeconds().toString();

  const requestData: GpsGetInventoryRequest["data"] = {
    pageNum: options.pageNum ?? 1,
    pageSize: options.pageSize ?? 100,
    ...(options.sku && { sku: options.sku }),
    ...(options.whCode && { whCode: options.whCode }),
  };

  const payload: GpsGetInventoryRequest = {
    appKey,
    reqTime: timestamp,
    data: requestData,
  };

  console.log(`[GPS] Fetching inventory: page ${requestData.pageNum}, size ${requestData.pageSize}`);

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would fetch inventory`);
    return {
      response: {
        code: 200,
        msg: "DRY RUN SUCCESS",
        data: {
          records: [],
          total: 0,
          page: 1,
          pageSize: requestData.pageSize,
          pages: 0,
        },
      },
      items: [],
    };
  }

  const authCode = generateAuthCode(requestData, timestamp, appKey, appSecret);

  const response = await fetch(
    `${baseUrl}/openapi/v1/integratedInventory/pageOpen?authcode=${authCode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const result: GpsGetInventoryResponse = await response.json();

  if (result.code !== 200) {
    throw new Error(`GPS Inventory API error: ${result.code} - ${result.msg}`);
  }

  console.log(`[GPS] Inventory fetched: ${result.data.records.length} items (page ${result.data.page}/${result.data.pages}, total ${result.data.total})`);

  return { response: result, items: result.data.records };
}

/**
 * Fetch ALL inventory from GPS (paginated, fetches all pages)
 */
export async function getAllInventory(
  options: {
    sku?: string;
    whCode?: string;
    pageSize?: number;
  } = {},
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<GpsInventoryItem[]> {
  const allItems: GpsInventoryItem[] = [];
  let page = 1;
  let totalPages = 1;
  const pageSize = options.pageSize ?? 100;

  console.log(`[GPS] Fetching all inventory...`);

  do {
    const { response } = await getInventory(
      { pageNum: page, pageSize, sku: options.sku, whCode: options.whCode },
      warehouseName
    );
    allItems.push(...response.data.records);
    totalPages = response.data.pages;
    page++;
  } while (page <= totalPages);

  console.log(`[GPS] Total inventory fetched: ${allItems.length} items`);
  return allItems;
}

// ============================================================================
// PRODUCT & INVENTORY SYNC (PLACEHOLDER)
// ============================================================================

/**
 * Sync a Shopify product/SKU to GPS warehouse system
 * TODO: Implement actual GPS product master sync (SKU registration)
 */
export async function syncProduct(product: {
  productId: string;
  title: string;
  variants: { sku: string; barcode: string | null; weight: number; weight_unit: string }[];
}): Promise<{ success: boolean; message: string }> {
  console.log(`[GPS] 🔄 syncProduct called for "${product.title}" (${product.productId})`);
  console.log(`[GPS]   Variants: ${product.variants.length}`);
  for (const v of product.variants) {
    console.log(`[GPS]   - SKU: ${v.sku}, Barcode: ${v.barcode}, Weight: ${v.weight}${v.weight_unit}`);
  }

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would sync product ${product.title}`);
    return { success: true, message: "DRY RUN - GPS product sync placeholder" };
  }

  // TODO: GPS product master / SKU registration API
  // Steps:
  //   1. Check if SKU already exists in GPS product master
  //   2. If not, register new SKU with barcode, weight, dimensions
  //   3. If yes, update product attributes
  // May involve:
  //   POST /openapi/v1/product/create or similar GPS endpoint
  console.log(`[GPS] ⚠️  Product sync not yet implemented - placeholder only`);
  return {
    success: true,
    message: "Placeholder - GPS product sync not yet implemented",
  };
}

/**
 * Sync inventory levels from Shopify to GPS warehouse
 * TODO: Implement actual GPS inventory adjustment
 */
export async function syncInventoryLevel(inventory: {
  inventoryItemId: string;
  locationId: string;
  available: number | null;
  sku?: string;
}): Promise<{ success: boolean; message: string }> {
  console.log(`[GPS] 🔄 syncInventoryLevel called for item ${inventory.inventoryItemId}`);
  console.log(`[GPS]   Location: ${inventory.locationId}, Available: ${inventory.available}, SKU: ${inventory.sku || "N/A"}`);

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would sync inventory for item ${inventory.inventoryItemId}`);
    return { success: true, message: "DRY RUN - GPS inventory sync placeholder" };
  }

  // TODO: GPS inventory adjustment API
  // Steps:
  //   1. Map Shopify inventory_item_id → GPS SKU
  //   2. Map Shopify location_id → GPS warehouse code
  //   3. Query current GPS stock level
  //   4. Create adjustment if different
  // May involve:
  //   POST /openapi/v1/inventory/adjust (if GPS supports it)
  //   or a manual stock count update via GPS API
  console.log(`[GPS] ⚠️  Inventory sync not yet implemented - placeholder only`);
  return {
    success: true,
    message: "Placeholder - GPS inventory sync not yet implemented",
  };
}

// Re-export for backwards compatibility
export { GpsOutboundOrder, GpsFulfilmentNotification };
