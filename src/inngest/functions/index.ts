// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

export { processShopifyOrder, processShopifyOrderPaid } from "./process-shopify-order";
export { processShopifyRefund } from "./process-shopify-refund";
export { processGpsFulfilment } from "./process-gps-fulfilment";
export { processShopifyFulfilment } from "./process-shopify-fulfilment";
export { processStordFulfilment } from "./process-stord-fulfilment";
export { processShopifyFulfillment } from "./process-shopify-fulfillment";
export { processOrderCancellation } from "./process-order-cancellation";
export { processOrderUpdate } from "./process-order-update";

// Re-export as array for easy registration
import { processShopifyOrder, processShopifyOrderPaid } from "./process-shopify-order";
import { processShopifyRefund } from "./process-shopify-refund";
import { processGpsFulfilment } from "./process-gps-fulfilment";
import { processShopifyFulfilment } from "./process-shopify-fulfilment";
import { processStordFulfilment } from "./process-stord-fulfilment";
import { processShopifyFulfillment } from "./process-shopify-fulfillment";
import { processOrderCancellation } from "./process-order-cancellation";
import { processOrderUpdate } from "./process-order-update";

export const functions = [
  processShopifyOrder,
  processShopifyOrderPaid,
  processShopifyRefund,
  processGpsFulfilment,
  processShopifyFulfilment,
  processStordFulfilment,
  processShopifyFulfillment,
  processOrderCancellation,
  processOrderUpdate,
];
