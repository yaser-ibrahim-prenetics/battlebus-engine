import { requestOosDrainFromInventory } from "./request-oos-drain-from-inventory";
import { processAdministrativeRecovery } from "./process-administrative-recovery";
import { cronD365Reconciliation } from "./cron-d365-reconciliation";
// ============================================================================
// INNGEST FUNCTIONS INDEX
// ============================================================================
// Export all Inngest functions for registration

import { assertChannelLiftConfiguration, config } from "@/lib/config";
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
export { processBackorder, processBackorderRetry } from "./process-backorder";
export { drainPendingActions } from "./drain-pending-actions";
export { drainWebhookInbox } from "./drain-webhook-inbox";
export { drainOosOutbox } from "./drain-oos-outbox";
export { processOosDrain, scheduleOosDrainSweep } from "./process-oos-drain";
export { processSubscriptionOrder } from "./process-subscription-order";
export { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
export { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
export { processShopifyOrderRecover } from "./process-shopify-order-recover";
export { recoverGpsFulfilment } from "./recover-gps-fulfillment";
export { processWarehouseWebhookFulfilment } from "./process-warehouse-webhook-fulfilment";
export { captureOpenAiAdsConversion } from "@/inngest/functions/capture-openai-ads-conversion";
export { deliverOpenAiAdsConversions } from "@/inngest/functions/deliver-openai-ads-conversions";
export { scheduleOpenAiAdsRetry } from "@/inngest/functions/schedule-openai-ads-retry";
export { processMetaChannelLift } from "@/inngest/functions/process-meta-channel-lift";
export { scheduleMetaChannelLift } from "@/inngest/functions/schedule-meta-channel-lift";
export { housekeepFulfillmentActions } from "@/inngest/functions/housekeep-fulfillment-actions";

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
import { processBackorder, processBackorderRetry } from "./process-backorder";
import { drainPendingActions } from "./drain-pending-actions";
import { drainWebhookInbox } from "./drain-webhook-inbox";
import { drainOosOutbox } from "./drain-oos-outbox";
import { processOosDrain, scheduleOosDrainSweep } from "./process-oos-drain";
import { processSubscriptionOrder } from "./process-subscription-order";
import { processDynamicsInitiatedFulfillment } from "./process-dynamics-initiated-fulfillment";
import { cronSalesorderReconciliation } from "./cron-salesorder-reconciliation";
import { processShopifyOrderRecover } from "./process-shopify-order-recover";
import { recoverGpsFulfilment } from "./recover-gps-fulfillment";
import { processWarehouseWebhookFulfilment } from "./process-warehouse-webhook-fulfilment";
import { captureOpenAiAdsConversion } from "@/inngest/functions/capture-openai-ads-conversion";
import { deliverOpenAiAdsConversions } from "@/inngest/functions/deliver-openai-ads-conversions";
import { scheduleOpenAiAdsRetry } from "@/inngest/functions/schedule-openai-ads-retry";
import { processMetaChannelLift } from "@/inngest/functions/process-meta-channel-lift";
import { scheduleMetaChannelLift } from "@/inngest/functions/schedule-meta-channel-lift";
import { housekeepFulfillmentActions } from "@/inngest/functions/housekeep-fulfillment-actions";

const openAiAdsDeliveryFunctions = config.openAiAds.enabled
  ? [deliverOpenAiAdsConversions, scheduleOpenAiAdsRetry]
  : [];

if (config.channelLift.enabled) assertChannelLiftConfiguration();
const channelLiftFunctions = config.channelLift.enabled
  ? [scheduleMetaChannelLift, processMetaChannelLift]
  : [];

export const functions = [
  requestOosDrainFromInventory,
  processAdministrativeRecovery,
  cronD365Reconciliation,
  drainSlackNotificationOutbox,
  housekeepFulfillmentActions,
  // Capture is always registered so disabled or incomplete delivery is visible and auditable.
  captureOpenAiAdsConversion,
  ...openAiAdsDeliveryFunctions,
  ...channelLiftFunctions,
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
  processBackorderRetry,
  // Stacked lifecycle action drain
  drainPendingActions,
  // Webhook inbox drain (safety net for inngest.send() failures)
  drainWebhookInbox,
  drainOosOutbox,
  processOosDrain,
  scheduleOosDrainSweep,
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
