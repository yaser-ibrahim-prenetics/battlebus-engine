// ============================================================================
// BATTLE HUB ACTION PROCESSORS
// ============================================================================
// These functions process actions triggered directly from Battle Hub.
// They enable real-time tracking in the Live Runs panel and can perform
// additional processing beyond what the Shopify webhooks handle.

import { inngest } from "../client";
import * as csPlatform from "@/lib/clients/cs-platform";

/**
 * Process Cancel Action
 * Triggered when a CS/Ops user cancels an order from Battle Hub.
 * The actual Shopify cancellation is already done by the API route.
 * This function handles real-time tracking and notifications.
 */
export const processActionCancel = inngest.createFunction(
  {
    id: "process-action-cancel",
    name: "Process Hub Cancel Action",
    retries: 1,
  },
  { event: "action/order.cancel" },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, reason, source } = event.data;

    // Log the action
    await step.run("log-cancel-action", async () => {
      console.log(`[Action] Cancel action tracked: ${shopifyOrderName} (${shopifyOrderId})`);
      console.log(`[Action] Reason: ${reason}, Source: ${source}`);
      return { logged: true };
    });

    // Notify CS Platform (optional - for audit trail)
    const notification = await step.run("notify-cs-platform", async () => {
      try {
        await csPlatform.sendOrderCancelled({
          orderId: shopifyOrderId,
          shopifyOrderName,
          reason,
        });
        return { notified: true };
      } catch (error) {
        console.warn("[Action] Failed to notify CS Platform:", error);
        return { notified: false, error: String(error) };
      }
    });

    return {
      status: "success",
      action: "cancel",
      shopifyOrderId,
      shopifyOrderName,
      reason,
      source,
      notification,
      processedAt: new Date().toISOString(),
    };
  }
);

/**
 * Process Refund Action
 * Triggered when a CS/Ops user refunds an order from Battle Hub.
 * The actual Shopify refund is already done by the API route.
 * This function handles real-time tracking and notifications.
 */
export const processActionRefund = inngest.createFunction(
  {
    id: "process-action-refund",
    name: "Process Hub Refund Action",
    retries: 1,
  },
  { event: "action/order.refund" },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, refundId, amount, reason, restock, source } = event.data;

    // Log the action
    await step.run("log-refund-action", async () => {
      console.log(`[Action] Refund action tracked: ${shopifyOrderName} (${shopifyOrderId})`);
      console.log(`[Action] Refund ID: ${refundId}, Amount: ${amount}, Restock: ${restock}`);
      return { logged: true };
    });

    // Note: D365 credit note is handled by the shopify/refund.created webhook flow
    // This function just provides real-time tracking

    return {
      status: "success",
      action: "refund",
      shopifyOrderId,
      shopifyOrderName,
      refundId,
      amount,
      reason,
      restock,
      source,
      processedAt: new Date().toISOString(),
    };
  }
);

/**
 * Process Fulfill Action
 * Triggered when a CS/Ops user fulfills an order from Battle Hub.
 * The actual Shopify fulfillment is already done by the API route.
 * This function handles real-time tracking and notifications.
 */
export const processActionFulfill = inngest.createFunction(
  {
    id: "process-action-fulfill",
    name: "Process Hub Fulfill Action",
    retries: 1,
  },
  { event: "action/order.fulfill" },
  async ({ event, step }: { event: any; step: any }) => {
    const { 
      shopifyOrderId, 
      shopifyOrderName, 
      fulfillmentId, 
      fulfillmentType, 
      platform, 
      trackingNumber, 
      carrier,
      source 
    } = event.data;

    // Log the action
    await step.run("log-fulfill-action", async () => {
      console.log(`[Action] Fulfill action tracked: ${shopifyOrderName} (${shopifyOrderId})`);
      console.log(`[Action] Fulfillment ID: ${fulfillmentId}, Type: ${fulfillmentType}, Platform: ${platform}`);
      console.log(`[Action] Tracking: ${trackingNumber} via ${carrier}`);
      return { logged: true };
    });

    // Note: D365 sync is handled by the shopify/order.fulfilled webhook flow
    // This function just provides real-time tracking

    return {
      status: "success",
      action: "fulfill",
      shopifyOrderId,
      shopifyOrderName,
      fulfillmentId,
      fulfillmentType,
      platform,
      trackingNumber,
      carrier,
      source,
      processedAt: new Date().toISOString(),
    };
  }
);
