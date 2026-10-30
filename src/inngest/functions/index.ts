import { processAdministrativeRecovery } from "./process-administrative-recovery";
import { cronD365Reconciliation } from "./cron-d365-reconciliation";
// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

import { drainSlackNotificationOutbox } from "./drain-slack-notifications";

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
export { processBackorder } from "./process-backorder";
export { drainPendingActions } from "./drain-pending-actions";
export { drainWebhookInbox } from "./drain-webhook-inbox";
export { processSubscriptionOrder } from "./process-subscription-order";
export { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
export { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
export { processShopifyOrderRecover } from "./process-shopify-order-recover";
export { recoverGpsFulfilment } from "./recover-gps-fulfillment";
export { processWarehouseWebhookFulfilment } from "./process-warehouse-webhook-fulfilment";

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
import { processBackorder } from "./process-backorder";
import { drainPendingActions } from "./drain-pending-actions";
import { drainWebhookInbox } from "./drain-webhook-inbox";
import { processSubscriptionOrder } from "./process-subscription-order";
import { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
import { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
import { processShopifyOrderRecover } from "./process-shopify-order-recover";
import { recoverGpsFulfilment } from "./recover-gps-fulfillment";
import { processWarehouseWebhookFulfilment } from "./process-warehouse-webhook-fulfilment";


export const functions = [
  processAdministrativeRecovery,
  cronD365Reconciliation,
  drainSlackNotificationOutbox,
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
  // Inventory workflows are owned by the inventory-service Inngest app.
  // Backorder Retry Queue
  processBackorder,
  // Stacked lifecycle action drain
  drainPendingActions,
  // Webhook inbox drain (safety net for inngest.send() failures)
  drainWebhookInbox,
  // Skio Subscription Renewal Orders
  processSubscriptionOrder,
  // Dynamics-originated shipment → create Shopify fulfillments
  processDynamicsInitiatedFulfillment,
  // Daily sales order reconciliation + Slack alerts
  cronSalesorderReconciliation,
  // Manual Shopify pull/recover (Hub-triggered)
  processShopifyOrderRecover,
  recoverGpsFulfilment,
  // Real-time GPS/STORD warehouse push notifications -> canonical fulfillment flow
  processWarehouseWebhookFulfilment,
];
