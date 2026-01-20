// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

export { processShopifyOrder } from "./process-shopify-order";
export { processRefund } from "./process-refund";
export { processGpsFulfilment } from "./process-gps-fulfilment";
export { processStordFulfilment } from "./process-stord-fulfilment";
export { processOrderCancellation } from "./process-order-cancellation";

// Re-export as array for easy registration
import { processShopifyOrder } from "./process-shopify-order";
import { processRefund } from "./process-refund";
import { processGpsFulfilment } from "./process-gps-fulfilment";
import { processStordFulfilment } from "./process-stord-fulfilment";
import { processOrderCancellation } from "./process-order-cancellation";

export const functions = [
  processShopifyOrder,
  processRefund,
  processGpsFulfilment,
  processStordFulfilment,
  processOrderCancellation,
];
