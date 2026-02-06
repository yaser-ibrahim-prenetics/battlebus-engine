// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

export { processShopifyOrder } from "./process-shopify-order";
export { processRefund } from "./process-refund";
export { processShopifyFulfillment } from "./process-shopify-fulfillment";
export { processOrderCancellation } from "./process-order-cancellation";
export { processOrderUpdate } from "./process-order-update";
export { syncGpsFulfillments } from "./cron-gps-sync";
export {
  processExtensivFulfillment,
  processExtensivReceiverConfirm,
} from "./process-extensiv-fulfillment";
export { simulateGpsFulfillment } from "./simulate-gps-fulfillment";
export {
  processActionCancel,
  processActionRefund,
  processActionFulfill,
} from "./process-hub-actions";

// Re-export as array for easy registration
import { processShopifyOrder } from "./process-shopify-order";
import { processRefund } from "./process-refund";
import { processShopifyFulfillment } from "./process-shopify-fulfillment";
import { processOrderCancellation } from "./process-order-cancellation";
import { processOrderUpdate } from "./process-order-update";
import { syncGpsFulfillments } from "./cron-gps-sync";
import {
  processExtensivFulfillment,
  processExtensivReceiverConfirm,
} from "./process-extensiv-fulfillment";
import { simulateGpsFulfillment } from "./simulate-gps-fulfillment";
import { processGpsBatch } from "./process-gps-batch";
import { processGpsIndividual } from "./process-gps-individual";
import {
  processActionCancel,
  processActionRefund,
  processActionFulfill,
} from "./process-hub-actions";

export const functions = [
  processShopifyOrder,
  processRefund,
  processShopifyFulfillment,
  processOrderCancellation,
  processOrderUpdate,
  syncGpsFulfillments,
  processExtensivFulfillment,
  processExtensivReceiverConfirm,
  simulateGpsFulfillment,
  processGpsBatch,
  processGpsIndividual,
  // Battle Hub Actions
  processActionCancel,
  processActionRefund,
  processActionFulfill,
];
