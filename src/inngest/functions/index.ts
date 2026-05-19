// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

import { config } from "@/lib/config";

export { processShopifyOrder } from "./process-shopify-order";
export { processRefund } from "./process-refund";
export { processShopifyFulfillment } from "./process-shopify-fulfillment";
export { processOrderCancellation } from "./process-order-cancellation";
export { processOrderUpdate } from "./process-order-update";
export { syncGpsFulfillments } from "./cron-gps-sync";
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
export { drainPendingActions } from "./drain-pending-actions";
export { processSubscriptionOrder } from "./process-subscription-order";
export {
  cronInventoryReconciliation,
  triggerInventoryReconciliation,
  syncSkuInventory,
} from "./cron-inventory-reconciliation";
export { refreshLocationConfigCache } from "./refresh-location-config-cache";
export { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
export { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
export { processShopifyOrderRecover } from "./process-shopify-order-recover";
export { recoverGpsFulfilment } from "./recover-gps-fulfillment";

// Re-export as array for easy registration
import { processShopifyOrder } from "./process-shopify-order";
import { processRefund } from "./process-refund";
import { processShopifyFulfillment } from "./process-shopify-fulfillment";
import { processOrderCancellation } from "./process-order-cancellation";
import { processOrderUpdate } from "./process-order-update";
import { syncGpsFulfillments } from "./cron-gps-sync";
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
import { drainPendingActions } from "./drain-pending-actions";
import { processSubscriptionOrder } from "./process-subscription-order";
import {
  cronInventoryReconciliation,
  triggerInventoryReconciliation,
  syncSkuInventory,
} from "./cron-inventory-reconciliation";
import { refreshLocationConfigCache } from "./refresh-location-config-cache";
import { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
import { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
import { processShopifyOrderRecover } from "./process-shopify-order-recover";
import { recoverGpsFulfilment } from "./recover-gps-fulfillment";

const inventoryFunctions = config.features.enableInventoryRuns
  ? [
      // Product & Inventory Sync
      processProductSync,
      processInventorySync,
      processInventoryMesh,
      processInventoryFullSync,
      // Location sync and cache refresh are inventory-adjacent flows.
      processLocationSync,
      refreshLocationConfigCache,
      // Inventory Reconciliation (3-way sync: GPS <-> D365 <-> Shopify)
      cronInventoryReconciliation,
      triggerInventoryReconciliation,
      syncSkuInventory,
    ]
  : [];

export const functions = [
  processShopifyOrder,
  processRefund,
  processShopifyFulfillment,
  processOrderCancellation,
  processOrderUpdate,
  syncGpsFulfillments,
  simulateGpsFulfillment,
  processGpsBatch,
  processGpsIndividual,
  // Battle Hub Actions
  processActionCancel,
  processActionRefund,
  processActionFulfill,
  // Product/Inventory flows are intentionally gated for staged rollout.
  ...inventoryFunctions,
  // Backorder Retry Queue
  processBackorder,
  // Stacked lifecycle action drain
  drainPendingActions,
  // Skio Subscription Renewal Orders
  processSubscriptionOrder,
  // Dynamics-originated shipment → create Shopify fulfillments
  processDynamicsInitiatedFulfillment,
  // Daily sales order reconciliation + Slack alerts
  cronSalesorderReconciliation,
  // Manual Shopify pull/recover (Hub-triggered)
  processShopifyOrderRecover,
  recoverGpsFulfilment,
];
