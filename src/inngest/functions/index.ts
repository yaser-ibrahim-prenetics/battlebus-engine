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
export { processProductSync } from "./process-product-sync";
export { processInventorySync } from "./process-inventory-sync";
export { processInventoryMesh } from "./process-inventory-mesh";
export { processInventoryFullSync } from "./process-inventory-full-sync";
export { processLocationSync } from "./process-location-sync";
export { processBackorder } from "./process-backorder";
export { processSubscriptionOrder } from "./process-subscription-order";

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
import { processProductSync } from "./process-product-sync";
import { processInventorySync } from "./process-inventory-sync";
import { processInventoryMesh } from "./process-inventory-mesh";
import { processInventoryFullSync } from "./process-inventory-full-sync";
import { processLocationSync } from "./process-location-sync";
import { processBackorder } from "./process-backorder";
import { processSubscriptionOrder } from "./process-subscription-order";

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
  // Product & Inventory Sync
  processProductSync,
  processInventorySync,
  processInventoryMesh,
  processInventoryFullSync,
  // Location Sync
  processLocationSync,
  // Backorder Retry Queue
  processBackorder,
  // Skio Subscription Renewal Orders
  processSubscriptionOrder,
];
