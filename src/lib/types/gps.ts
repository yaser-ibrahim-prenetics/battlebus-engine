// ============================================================================
// GPS WAREHOUSE TYPES
// ============================================================================

export interface GpsOutboundOrder {
  orderNumber: string;
  orderDate: string;
  customerCode: string;
  shipToName: string;
  shipToAddress1: string;
  shipToAddress2?: string;
  shipToCity: string;
  shipToState: string;
  shipToZip: string;
  shipToCountry: string;
  shipToPhone?: string;
  shipToEmail?: string;
  carrierCode: string;
  serviceCode: string;
  items: GpsOrderItem[];
  // IM8 Custom Fields
  shopifyOrderId?: string;
  shopifyOrderName?: string;
}

export interface GpsOrderItem {
  sku: string;
  quantity: number;
  description?: string;
  unitPrice?: number;
}

export interface GpsFulfilmentNotification {
  orderId: string;
  orderNumber: string;
  status: "shipped" | "cancelled" | "partial";
  trackingNumber?: string;
  carrierCode?: string;
  shippedDate?: string;
  items: GpsFulfilledItem[];
}

export interface GpsFulfilledItem {
  sku: string;
  quantityShipped: number;
  quantityOrdered: number;
}

export interface GpsApiConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  warehouseCode: string;
}

export interface GpsAuthHeader {
  "X-API-Key": string;
  "X-Signature": string;
  "X-Timestamp": string;
}

export interface IGpsIndividualFulfilment {
  type: "individual";
  warehouse: string; // e.g., "GPS Warehouse"
  orderData: IGpsIndividualOrderData;
}

export interface IGpsIndividualOrderData {
  // Order identifiers
  outboundOrderNo: string; // GPS internal order number, e.g., "OBS1632601170SM"
  platformOrderNo: string; // Shopify order name, e.g., "IM8-591560"
  referOrderNo: string; // D365 sales order number, e.g., "U001-SO-459898"
  thirdOrderNo: string; // Same as referOrderNo

  // Order status
  status: number; // 3 = shipped (已出库)
  statusName: string; // e.g., "已出库"

  // Warehouse info
  whCode: string; // Warehouse code, e.g., "JFK01W"

  // Customer info
  email: string;
  receiver: string; // Customer name
  telephone: string;
  companyName: string;

  // Shipping address
  addressOne: string;
  addressTwo: string;
  cityName: string;
  cityCode: string;
  provinceName: string;
  provinceCode: string;
  postCode: string;
  countryRegionCode: string; // ISO2 code, e.g., "AE"
  countryRegionName: string; // e.g., "United Arab Emirates"
  houseNum: string;

  // Products shipped
  productList: GpsIndividualProductItem[];

  // Shipment/tracking info
  expressList: GpsExpressItem[];
  logisticsCarrier: string; // e.g., "GPS"
  logisticsChannel: string; // e.g., "GPS-IM8-STANDARD"
  logisticsTrackNo: string; // Primary tracking number
  logisticsTrackNos: string[]; // All tracking numbers

  // Timestamps
  orderCreateTime: string; // Format: "YYYY-MM-DD HH:mm:ss"
  outboundTime: string; // When shipped, Format: "YYYY-MM-DD HH:mm:ss"
  canceledTime: string;
  exceptionTime: string;
  interceptTime: string;

  // Cost info
  costItems: GpsCostItem[];
  costTotal: number;
  costCurrencyCode: string; // e.g., "USD"

  // Order type
  orderTypeName: string; // e.g., "小包出库单"
  subOrderTypeName: string;
  salesPlatform: string; // e.g., "9"

  // Exception handling
  exceptionDesc: string;

  // Additional fields
  remark: string;
  taxNum: string;
  orderList: string;
  storeName: string;
  needRelabel: number; // 0 or 1
  appendixList: unknown[];
}

export interface GpsIndividualProductItem {
  sku: string;
  skuId: string; // e.g., "1082163IM8-FG-000010"
  fnsku: string;
  productName: string;
  productAliasName: string;
  quantity: number; // Ordered quantity
  realQuantity: number; // Actually shipped quantity
  availableAmount: number; // Stock available
  remark: string;
  deleted: number; // 0 or 1
  createBy: string; // e.g., "OPENAPI"
  updateBy: string; // e.g., "system"
  createTime: string;
  updateTime: string;
}

export interface GpsExpressItem {
  trackNo: string; // Tracking number
  pkgSkuNumInfo: string; // e.g., "IM8-FG-000010*2"
  weight: number; // kg
  length: number; // cm
  width: number; // cm
  height: number; // cm
  fileUrl: string; // Label URL if any
}

export interface GpsCostItem {
  billItemName: string; // e.g., "IM8-operation"
  billItemTotal: number; // Cost amount
}

export interface IGpsGetOrderData {
  outboundOrderNo: string;
  status: number;
  logisticsTrackNo: string;
  logisticsCarrier: string;
  platformOrderNo: string; // Shopify order name like "IM8-5654"
  outboundTime: string; // ISO 8601 timestamp when order shipped
  referOrderNo?: string; // D365 sales order number (optional for backward compat)
  thirdOrderNo?: string;
  productList?: GpsIndividualProductItem[]; // Optional detailed product info
  expressList?: GpsExpressItem[]; // Optional tracking details
}

export interface IGpsManualProcessRequest {
  gpsOrderIds: string[];
  warehouse: string;
}

export enum GpsWarehouseNameEnum {
  gpsUS = "GPS Warehouse",
  gpsUK = "GPS UK Warehouse",
}

export interface IGpsProcessingOrder {
  gpsOrderId: string;
}

export function isGpsIndividualFulfilmentPayload(
  payload: unknown
): payload is IGpsIndividualFulfilment {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as IGpsIndividualFulfilment).type === "individual" &&
    typeof (payload as IGpsIndividualFulfilment).orderData === "object"
  );
}
