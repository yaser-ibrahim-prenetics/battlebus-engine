export type ReconType = "salesorder" | "gps_us" | "gps_uk" | "fulfillment";

export type OrderRow = {
  shopify_order_name: string | null;
  d365_order_number: string | null;
  d365_sync_status: string | null;
  gps_order_no: string | null;
  gps_uk_order_no: string | null;
  gps_sync_status: string | null;
  shopify_financial_status: string | null;
  shopify_cancelled_at: string | null;
  shopify_fulfillment_status: string | null;
  warehouse: string | null;
};

export type ShopifyWindowOrder = {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  totalPrice: string | null;
};

export type ReconResult = {
  type: ReconType;
  checkId: string;
  dateFrom: string;
  dateTo: string;
  totalOrders: number;
  matchedOrders: number;
  unsyncedOrders: string[];
  unsyncedOrderIds: string[];
  missingDbFulfillmentIds?: string[];
  missingDbFulfillments?: string[];
  missingShopifyFulfillments?: string[];
  status: "ok" | "error";
  message: string;
};


