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
