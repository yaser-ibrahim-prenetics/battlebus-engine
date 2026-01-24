// ============================================================================
// GPS WAREHOUSE API CLIENT
// ============================================================================
// Ported from spock-store src/component/integration/gps.ts
// Uses correct GPS auth code algorithm with sorted keys

import crypto from "crypto";
import { config } from "../config";
import type { GpsOutboundOrder, GpsFulfilmentNotification } from "../types/gps";
import warehouseConfig from "../mappings/warehouse-config.json";

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
  if (result.code !== 200) {
    if (
      result.msg?.toLowerCase().includes("out of stock") ||
      result.msg?.toLowerCase().includes("insufficient")
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
      orderResult.msg?.toLowerCase().includes("insufficient")
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

  console.log(`[GPS] Order details response: ${JSON.stringify(result)}`);

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

// Re-export for backwards compatibility
export { GpsOutboundOrder, GpsFulfilmentNotification };
