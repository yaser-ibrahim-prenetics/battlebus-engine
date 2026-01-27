// ============================================================================
// API CLIENTS INDEX
// ============================================================================
// Re-export all API clients for easy importing

export * as dynamics from "./dynamics";
export * as gps from "./gps";
export * as shopify from "./shopify";

// Named exports for common functions
export {
  authenticate as authenticateD365,
  createSalesOrderHeaderV3,
  createSalesOrderLine,
  confirmSalesOrder,
  createPrepayment,
  createFulfilment,
  getSalesOrderByShopifyId,
  DYNAMICS_THK_API_SUCCESS_STATUS,
} from "./dynamics";

export {
  createOutboundOrder as createGpsOutboundOrder,
  getOutboundOrdersDetails as getGpsOrderDetails,
  cancelOutboundOrder as cancelGpsOrder,
  verifyWebhookSignature as verifyGpsWebhook,
  generateAuthCode as generateGpsAuthCode,
  OutOfStockError,
  GpsOrderType,
} from "./gps";

export {
  getOrder as getShopifyOrder,
  getFulfillmentOrders as getShopifyFulfillmentOrders,
  createFulfillment as createShopifyFulfillment,
  getOrderTransactions as getShopifyTransactions,
  verifyWebhookSignature as verifyShopifyWebhook,
  getOrderRisks as getOrderRisks,
} from "./shopify";
