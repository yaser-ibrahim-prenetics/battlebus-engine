// ============================================================================
// BATTLE HUB ACTION PROCESSORS
// ============================================================================
// These functions process actions triggered directly from Battle Hub.
// They enable real-time tracking in the Live Runs panel and can perform
// additional processing beyond what the Shopify webhooks handle.

import { inngest } from "../client";
import * as csPlatform from "@/lib/clients/cs-platform";
import { CONCURRENCY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

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
    concurrency: [{ ...CONCURRENCY_CONFIGS.CANCELLATION, key: "event.data.shopifyOrderId" }],
    triggers: [{ event: "action/order.cancel" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const { shopifyOrderId, shopifyOrderName, reason, source } = event.data;
    const _flowStart = Date.now();
    const _runId = String(runId ?? "") || undefined;

    logFlowEvent({
      flow: "hub_cancel",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      payload: { reason, source },
    });

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

    logFlowEvent({
      flow: "hub_cancel",
      step: "done",
      status: "completed",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      durationMs: Date.now() - _flowStart,
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
    concurrency: [{ ...CONCURRENCY_CONFIGS.REFUND, key: "event.data.shopifyOrderId" }],
    triggers: [{ event: "action/order.refund" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const { shopifyOrderId, shopifyOrderName, refundId, amount, reason, restock, source } =
      event.data;
    const _flowStart = Date.now();
    const _runId = String(runId ?? "") || undefined;

    logFlowEvent({
      flow: "hub_refund",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      payload: { refundId, amount, restock },
    });

    // Log the action
    await step.run("log-refund-action", async () => {
      console.log(`[Action] Refund action tracked: ${shopifyOrderName} (${shopifyOrderId})`);
      console.log(`[Action] Refund ID: ${refundId}, Amount: ${amount}, Restock: ${restock}`);
      return { logged: true };
    });

    logFlowEvent({
      flow: "hub_refund",
      step: "done",
      status: "completed",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      durationMs: Date.now() - _flowStart,
    });
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
    concurrency: [{ ...CONCURRENCY_CONFIGS.FULFILLMENT, key: "event.data.shopifyOrderId" }],
    triggers: [{ event: "action/order.fulfill" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const {
      shopifyOrderId,
      shopifyOrderName,
      fulfillmentId,
      fulfillmentType,
      platform,
      trackingNumber,
      carrier,
      source,
    } = event.data;
    const _flowStart = Date.now();
    const _runId = String(runId ?? "") || undefined;

    logFlowEvent({
      flow: "hub_fulfill",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      payload: { fulfillmentId, fulfillmentType, trackingNumber },
    });

    // Log the action
    await step.run("log-fulfill-action", async () => {
      console.log(`[Action] Fulfill action tracked: ${shopifyOrderName} (${shopifyOrderId})`);
      console.log(
        `[Action] Fulfillment ID: ${fulfillmentId}, Type: ${fulfillmentType}, Platform: ${platform}`
      );
      console.log(`[Action] Tracking: ${trackingNumber} via ${carrier}`);
      return { logged: true };
    });

    logFlowEvent({
      flow: "hub_fulfill",
      step: "done",
      status: "completed",
      runId: _runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      durationMs: Date.now() - _flowStart,
    });
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
