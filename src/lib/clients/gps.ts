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

const _omsMinIntervalParsed = parseInt(process.env.OMS_CLIENT_MIN_INTERVAL_MS || "120", 10);
const OMS_MIN_INTERVAL_MS = Math.max(0, Number.isNaN(_omsMinIntervalParsed) ? 120 : _omsMinIntervalParsed);
const _omsMaxRetriesParsed = parseInt(process.env.OMS_CLIENT_MAX_RETRIES || "3", 10);
const OMS_MAX_RETRIES = Math.max(1, Number.isNaN(_omsMaxRetriesParsed) ? 3 : _omsMaxRetriesParsed);
const _omsRetryBaseParsed = parseInt(process.env.OMS_CLIENT_RETRY_BASE_MS || "300", 10);
const OMS_RETRY_BASE_MS = Math.max(100, Number.isNaN(_omsRetryBaseParsed) ? 300 : _omsRetryBaseParsed);
const _omsMaxOutboundParsed = parseInt(process.env.OMS_MAX_OUTBOUND_CREATE_BATCH || "100", 10);
const OMS_MAX_OUTBOUND_CREATE_BATCH = Math.max(1, Number.isNaN(_omsMaxOutboundParsed) ? 100 : _omsMaxOutboundParsed);
const _omsMaxProductParsed = parseInt(process.env.OMS_MAX_PRODUCT_BATCH_CREATE || "200", 10);
const OMS_MAX_PRODUCT_BATCH_CREATE = Math.max(1, Number.isNaN(_omsMaxProductParsed) ? 200 : _omsMaxProductParsed);
const _omsMaxInventoryParsed = parseInt(process.env.OMS_MAX_INVENTORY_PAGE_SIZE || "100", 10);
const OMS_MAX_INVENTORY_PAGE_SIZE = Math.max(1, Number.isNaN(_omsMaxInventoryParsed) ? 100 : _omsMaxInventoryParsed);
const _omsMaxDetailParsed = parseInt(process.env.OMS_MAX_OUTBOUND_DETAIL_IDS || "50", 10);
const OMS_MAX_OUTBOUND_DETAIL_IDS = Math.max(1, Number.isNaN(_omsMaxDetailParsed) ? 50 : _omsMaxDetailParsed);

const omsQueueByWarehouse = new Map<string, Promise<void>>();
const omsLastRequestAtByWarehouse = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeOmsCode(code: unknown): number {
  const n = Number(code);
  return Number.isFinite(n) ? n : -1;
}

function isRetryableOmsCode(code: number): boolean {
  return (
    code === 100002 || // timestamp timeout
    code === 100011 || // remote invocation failure
    code === 200001 // temporary query limit exceeded
  );
}

async function withOmsPacing<T>(warehouseKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = omsQueueByWarehouse.get(warehouseKey) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  omsQueueByWarehouse.set(warehouseKey, previous.then(() => gate));

  await previous;
  try {
    if (OMS_MIN_INTERVAL_MS > 0) {
      const now = Date.now();
      const last = omsLastRequestAtByWarehouse.get(warehouseKey) || 0;
      const waitMs = Math.max(0, last + OMS_MIN_INTERVAL_MS - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      omsLastRequestAtByWarehouse.set(warehouseKey, Date.now());
    }
    return await fn();
  } finally {
    release();
  }
}

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

interface GpsCancelOrderItem {
  outboundOrderNo: string;
  thirdOrderNo?: string;
  msg?: string;
  status?: number; // 0 processing, 2 failed validation
}

interface GpsCancelOrderResponse {
  code: number;
  msg: string;
  data?: GpsCancelOrderItem[];
}

interface GpsCancelBizStatusItem {
  outboundOrderNo: string;
  status: number; // 0 processing, 1 success, 2 failed
  msg?: string;
}

interface GpsCancelBizStatusResponse {
  code: number;
  msg: string;
  data?: GpsCancelBizStatusItem[];
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

async function postOms<TResponse>(
  endpointPath: string,
  requestData: unknown,
  warehouseName: GpsWarehouseName
): Promise<TResponse> {
  const { appKey, appSecret, baseUrl } = getApiCredentials(warehouseName);
  const queueKey = `${warehouseName}:${baseUrl}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= OMS_MAX_RETRIES; attempt++) {
    const timestamp = epochInSeconds().toString();
    const payload = {
      appKey,
      reqTime: timestamp,
      data: requestData,
    };
    const authCode = generateAuthCode(requestData, timestamp, appKey, appSecret);
    const url = `${baseUrl}${endpointPath}?authcode=${authCode}`;

    try {
      const response = await withOmsPacing(queueKey, () =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        })
      );

      if (!response.ok) {
        if (
          attempt < OMS_MAX_RETRIES &&
          (response.status === 429 || response.status >= 500)
        ) {
          await sleep(Math.min(OMS_RETRY_BASE_MS * 2 ** (attempt - 1), 5000));
          continue;
        }
        throw new Error(`OMS HTTP error ${response.status} for ${endpointPath}`);
      }

      const json = (await response.json()) as any;
      const code = normalizeOmsCode(json?.code);
      if (code === 200) {
        return json as TResponse;
      }

      if (attempt < OMS_MAX_RETRIES && isRetryableOmsCode(code)) {
        await sleep(Math.min(OMS_RETRY_BASE_MS * 2 ** (attempt - 1), 5000));
        continue;
      }

      return json as TResponse;
    } catch (error) {
      lastError = error;
      if (attempt >= OMS_MAX_RETRIES) break;
      await sleep(Math.min(OMS_RETRY_BASE_MS * 2 ** (attempt - 1), 5000));
    }
  }

  throw (
    lastError ||
    new Error(`OMS request failed for ${endpointPath} after ${OMS_MAX_RETRIES} attempts`)
  );
}

/**
 * Create an Outbound Order in GPS Warehouse
 * Ported from spock-store with correct auth code generation
 */
export async function createOutboundOrder(
  orderData: GpsOrderData,
  warehouseName: GpsWarehouseName = "GPS Warehouse",
  isRetry: boolean = false
): Promise<{
  response: GpsCreateOrderResponse;
  request: GpsCreateOrderRequest;
}> {
  // Validate warehouse exists
  getWarehouseConfig(warehouseName);
  const data: GpsOrderData[] = [orderData];
  if (data.length > OMS_MAX_OUTBOUND_CREATE_BATCH) {
    throw new Error(
      `GPS outbound create batch exceeds limit (${data.length} > ${OMS_MAX_OUTBOUND_CREATE_BATCH})`
    );
  }

  const payload: GpsCreateOrderRequest = {
    data,
    appKey: getApiCredentials(warehouseName).appKey,
    reqTime: epochInSeconds().toString(),
  };

  console.log(`[GPS] Creating outbound order: ${JSON.stringify(payload)}`);

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would create order for ${orderData.platformOrderNo}`);
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

  const result = await postOms<GpsCreateOrderResponse>(
    "/openapi/v1/outboundOrder/create",
    data,
    warehouseName
  );

  console.log(`[GPS] Response: ${JSON.stringify(result)}`);

  // Check for inventory-related errors
  // GPS API returns Chinese error messages:
  //   库存不足 = "insufficient inventory"
  //   未维护新品 = "unmaintained new product" (SKU not registered in GPS warehouse)
  if (result.code !== 200) {
    if (isGpsInventoryError(result.msg)) {
      throw new OutOfStockError(`GPS inventory error: ${result.msg}`);
    }
    throw new Error(`GPS API error: ${result.code} - ${result.msg}`);
  }

  // Check individual order result
  if (result.data?.[0] && !result.data[0].success) {
    const orderResult = result.data[0];
    if (isGpsInventoryError(orderResult.msg)) {
      throw new OutOfStockError(
        `GPS inventory error for ${orderData.platformOrderNo}: ${orderResult.msg}`
      );
    }

    // Check if it's a logistics channel error - try fallback channel (only once)
    if (
      !isRetry &&
      (orderResult.msg?.includes("物流渠道") ||
        orderResult.msg?.includes("logistics channel") ||
        orderResult.msg?.includes("渠道") ||
        orderResult.msg?.toLowerCase().includes("channel"))
    ) {
      console.warn(
        `[GPS] Logistics channel error: ${orderResult.msg}. Retrying with fallback channel "No_Shipping_Service"...`
      );

      // Retry with fallback channel
      const fallbackOrderData = {
        ...orderData,
        logisticsChannel: "No_Shipping_Service",
      };

      return createOutboundOrder(fallbackOrderData, warehouseName, true);
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
    const mockData = await import("../mocks/gps/outboundOrders.json");
    console.log(`Using mock GPS outbound data for order ${orderIds}`);
    return {
      response: {
        code: 200,
        msg: "操作成功",
        data: mockData.default,
      },
    };
  }

  const requestChunks = chunkArray(orderIds, OMS_MAX_OUTBOUND_DETAIL_IDS);
  if (requestChunks.length === 0) {
    return {
      response: { code: 200, msg: "操作成功", data: [] },
    };
  }

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

  const merged: GpsGetOrdersDetailResponse = {
    code: 200,
    msg: "操作成功",
    data: [],
  };

  for (const chunk of requestChunks) {
    const requestData = { outboundOrderNoList: chunk };
    const result = await postOms<GpsGetOrdersDetailResponse>(
      "/openapi/v1/outboundOrder/detail",
      requestData,
      warehouseName
    );
    if (result.code !== 200) {
      return { response: result };
    }
    if (Array.isArray(result.data)) {
      merged.data.push(...result.data);
    }
  }

  return { response: merged };
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

  const _pollAttemptsParsed = parseInt(process.env.OMS_CANCEL_STATUS_POLL_ATTEMPTS || "8", 10);
  const pollAttempts = Math.max(1, Number.isNaN(_pollAttemptsParsed) ? 8 : _pollAttemptsParsed);
  const _pollIntervalParsed = parseInt(process.env.OMS_CANCEL_STATUS_POLL_INTERVAL_MS || "3000", 10);
  const pollIntervalMs = Math.max(500, Number.isNaN(_pollIntervalParsed) ? 3000 : _pollIntervalParsed);

  const cancelRequest = { outboundOrderNoList: [orderNumber] };
  const cancelResponse = await postOms<GpsCancelOrderResponse>(
    "/openapi/v1/outboundOrder/cancel",
    cancelRequest,
    warehouseName
  );

  if (Number(cancelResponse?.code) !== 200) {
    return {
      success: false,
      message: cancelResponse?.msg || `GPS cancel request failed (code=${cancelResponse?.code})`,
    };
  }

  const cancelItem = Array.isArray(cancelResponse?.data)
    ? cancelResponse.data.find((x) => x.outboundOrderNo === orderNumber) || cancelResponse.data[0]
    : undefined;
  if (cancelItem?.status === 2) {
    return {
      success: false,
      message: cancelItem.msg || "GPS cancel pre-check failed",
    };
  }

  // OMS cancellation is asynchronous; poll aggregate status until terminal.
  for (let attempt = 1; attempt <= pollAttempts; attempt++) {
    const bizStatus = await postOms<GpsCancelBizStatusResponse>(
      "/openapi/v1/outboundOrder/selectBizStatus",
      cancelRequest,
      warehouseName
    );

    if (Number(bizStatus?.code) !== 200) {
      if (attempt < pollAttempts) {
        await sleep(pollIntervalMs);
        continue;
      }
      return {
        success: false,
        message: bizStatus?.msg || `GPS cancel status query failed (code=${bizStatus?.code})`,
      };
    }

    const row = Array.isArray(bizStatus?.data)
      ? bizStatus.data.find((x) => x.outboundOrderNo === orderNumber) || bizStatus.data[0]
      : undefined;
    const status = Number(row?.status);

    if (status === 1) {
      return { success: true, message: row?.msg || "GPS cancellation successful" };
    }
    if (status === 2) {
      return { success: false, message: row?.msg || "GPS cancellation rejected" };
    }

    if (attempt < pollAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  return {
    success: false,
    message: `GPS cancellation still processing after ${pollAttempts} polls`,
  };
}

/**
 * Verify GPS Webhook Signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  const expectedSignature = sha256Hmac(`${timestamp}${payload}`, config.gps.apiSecret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

// GPS inventory error types
export type GpsInventoryErrorType =
  | "out_of_stock"
  | "unmaintained_product"
  | "gps_error"
  | "inventory_insufficient";

/**
 * Detect GPS inventory-related errors from error messages.
 * Covers all known Chinese and English error patterns from GPS API.
 *
 * Known GPS error patterns:
 *   库存不足 = insufficient inventory
 *   未维护新品 = unmaintained new product (SKU not registered in warehouse)
 *   cannot be reserved = D365 inventory reservation failure
 */
export function isGpsInventoryError(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("out of stock") ||
    lower.includes("insufficient") ||
    msg.includes("库存不足") ||
    msg.includes("未维护新品") ||
    lower.includes("cannot be reserved") ||
    (lower.includes("inventory") && lower.includes("error"))
  );
}

/**
 * Classify the GPS error type for backorder tracking
 */
export function classifyGpsError(msg: string | undefined): GpsInventoryErrorType {
  if (!msg) return "gps_error";
  if (
    msg.includes("库存不足") ||
    msg.toLowerCase().includes("out of stock") ||
    msg.toLowerCase().includes("insufficient")
  ) {
    return "out_of_stock";
  }
  if (msg.includes("未维护新品")) {
    return "unmaintained_product";
  }
  if (msg.toLowerCase().includes("cannot be reserved")) {
    return "inventory_insufficient";
  }
  return "gps_error";
}

// Custom error for inventory-related GPS scenarios
export class OutOfStockError extends Error {
  public readonly errorType: GpsInventoryErrorType;

  constructor(message: string) {
    super(message);
    this.name = "OutOfStockError";
    this.errorType = classifyGpsError(message);
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
    pageSize: Math.min(OMS_MAX_INVENTORY_PAGE_SIZE, options.pageSize ?? 100),
    ...(options.sku && { sku: options.sku }),
    ...(options.whCode && { whCode: options.whCode }),
  };

  const payload: GpsGetInventoryRequest = {
    appKey,
    reqTime: timestamp,
    data: requestData,
  };

  console.log(
    `[GPS] Fetching inventory: page ${requestData.pageNum}, size ${requestData.pageSize}`
  );

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

  const result = await postOms<GpsGetInventoryResponse>(
    "/openapi/v1/integratedInventory/pageOpen",
    requestData,
    warehouseName
  );

  if (result.code !== 200) {
    throw new Error(`GPS Inventory API error: ${result.code} - ${result.msg}`);
  }

  console.log(
    `[GPS] Inventory fetched: ${result.data.records.length} items (page ${result.data.page}/${result.data.pages}, total ${result.data.total})`
  );

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
 * Uses GPS /openapi/v1/product/batchCreate API to register products (supports up to 200 products per batch)
 * API Documentation: https://api.xlwms.com
 */
export async function syncProduct(
  product: {
    productId: string;
    title: string;
    variants: { sku: string; barcode: string | null; weight: number; weight_unit: string }[];
  },
  warehouseName: GpsWarehouseName = "GPS Warehouse"
): Promise<{ success: boolean; message: string }> {
  console.log(`[GPS] 🔄 syncProduct called for "${product.title}" (${product.productId})`);
  console.log(`[GPS]   Variants: ${product.variants.length}`);
  for (const v of product.variants) {
    console.log(
      `[GPS]   - SKU: ${v.sku}, Barcode: ${v.barcode}, Weight: ${v.weight}${v.weight_unit}`
    );
  }

  if (config.features.dryRunMode) {
    console.log(`[GPS] DRY RUN - Would sync product ${product.title}`);
    return { success: true, message: "DRY RUN - GPS product sync" };
  }

  // Validate variants array exists and is not empty
  if (!product.variants || !Array.isArray(product.variants) || product.variants.length === 0) {
    console.log(`[GPS] ⚠️  No variants to sync for product ${product.productId}`);
    return { success: false, message: "No variants to sync" };
  }

  // Validate warehouse exists
  getWarehouseConfig(warehouseName);
  const { appKey, appSecret, baseUrl } = getApiCredentials(warehouseName);

  // Build product data array for batch create (max 200 per batch)
  const productDataArray: any[] = [];

  // Filter out invalid variants and process valid ones
  const validVariants = product.variants.filter((v) => v && typeof v === "object");

  if (validVariants.length === 0) {
    console.log(`[GPS] ⚠️  No valid variants to sync for product ${product.productId}`);
    return { success: false, message: "No valid variants to sync" };
  }

  for (const variant of validVariants) {
    if (!variant.sku || variant.sku.trim() === "") {
      console.log(`[GPS] ⚠️  Skipping variant without SKU`);
      continue;
    }

    // Convert weight to kg if needed (GPS requires kg)
    const weightInKg =
      variant.weight && variant.weight > 0
        ? variant.weight_unit?.toLowerCase() === "kg"
          ? variant.weight
          : variant.weight * 0.453592 // Convert lb to kg
        : 0.001; // Minimum weight required by GPS (0.001 kg)

    // Build GPS product payload according to API documentation
    const gpsProduct: any = {
      sku: variant.sku,
      productCode: variant.barcode || variant.sku, // Required: EAN/UPC barcode, fallback to SKU
      productName: product.title || variant.sku, // Required
      // Optional fields
      productAliasName: variant.sku, // Product alias
      productDescription: product.title, // Product description
      // Dimensions (required but we don't have them from Shopify, use defaults)
      length: "1", // Required: Default to 1cm (GPS accepts 0.001~99999.999)
      width: "1", // Required: Default to 1cm
      height: "1", // Required: Default to 1cm
      sizeUnit: "cm", // Optional: Defaults to cm
      // Weight (required)
      weight: weightInKg.toString(), // Required: Convert to string as GPS expects string
      weightUnit: "kg", // Optional: Defaults to kg
      // Declaration fields (required for customs)
      declareNameCn: product.title || variant.sku, // Required: Chinese declaration name
      declareNameEn: product.title || variant.sku, // Required: English declaration name
      customhouseCode: "", // Optional: Customs code
      declarePrice: "0.01", // Required: Declaration price (default to $0.01 USD)
      currencyCode: "USD", // Required: Currency code (fixed to USD per docs)
      countryOfOriginName: "CN", // Required: Country of origin (default to CN)
      dangerousCargo: "1", // Required: 1=普货（非危险品） - General cargo (non-dangerous)
    };

    // Add optional barcode lists if available
    if (variant.barcode && variant.barcode !== variant.sku) {
      gpsProduct.otherCodeList = [{ otherCode: variant.barcode }];
    }

    productDataArray.push(gpsProduct);
  }

  // Check if we had any variants with SKUs to process
  const variantsWithSkus = product.variants.filter((v) => v.sku && v.sku.trim() !== "");

  if (variantsWithSkus.length === 0) {
    return { success: false, message: "No variants with SKUs to sync" };
  }

  if (productDataArray.length === 0) {
    return {
      success: false,
      message: `No valid variants to sync (${variantsWithSkus.length} variant(s) had SKUs but were filtered out)`,
    };
  }

  try {
    const chunks = chunkArray(productDataArray, OMS_MAX_PRODUCT_BATCH_CREATE);
    let successCount = 0;
    const failures: string[] = [];

    for (const chunk of chunks) {
      console.log(
        `[GPS] Batch creating ${chunk.length} product(s) via /openapi/v1/product/batchCreate`
      );
      const result: any = await postOms<any>(
        "/openapi/v1/product/batchCreate",
        chunk,
        warehouseName
      );

      if (normalizeOmsCode(result?.code) !== 200) {
        failures.push(`batch(${chunk.length}): ${result?.msg || "Unknown OMS error"}`);
        continue;
      }

      const failedProducts = result.data?.filter((item: any) => !item.success) || [];
      const successProducts = result.data?.filter((item: any) => item.success) || [];
      successCount += successProducts.length;

      if (failedProducts.length > 0) {
        failures.push(
          ...failedProducts.map((p: any) => `${p.sku}: ${p.message || "Unknown error"}`)
        );
      }
    }

    if (failures.length > 0) {
      return {
        success: successCount > 0,
        message: `Synced ${successCount}/${productDataArray.length} product(s) to GPS. Failures: ${failures.join(", ")}`,
      };
    }

    console.log(`[GPS] ✅ Successfully synced ${successCount} product(s) to GPS`);
    return {
      success: true,
      message: `Successfully synced ${successCount} product(s) to GPS`,
    };
  } catch (error) {
    console.error(`[GPS] Error syncing products:`, error);
    return {
      success: false,
      message: `Error syncing products to GPS: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  console.log(
    `[GPS]   Location: ${inventory.locationId}, Available: ${inventory.available}, SKU: ${inventory.sku || "N/A"}`
  );

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
