// ============================================================================
// DRAIN PENDING ACTIONS — CRON SWEEP
// ============================================================================
// Single scheduled sweep (every 2 minutes) that fetches ALL orders with
// pending lifecycle actions in one Hub API call, emits all events in one
// batch inngest.send(), and bulk-clears them in one update.
//
// Replaces the previous per-order event-triggered approach which spawned one
// Inngest function run per order and N steps per action — wasteful when
// processing hundreds of orders simultaneously.
//
// Priority:   cancel > refund > fulfill  (cancel beats everything)
// Durability: 2 steps total (sweep + clear), regardless of order count.

import { inngest } from "../client";
import {
  getAllPendingActionOrders,
  clearPendingActionsBatch,
  type PendingAction,
} from "@/lib/services/pending-actions";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

export const drainPendingActions = inngest.createFunction(
  {
    id: "drain-pending-actions",
    name: "Drain Pending Lifecycle Actions",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    // Only one sweep at a time — prevents overlapping cron runs from
    // double-emitting the same pending actions.
    concurrency: { limit: 1 },
    triggers: [{ cron: `*/${config.pendingActions.drainIntervalMinutes} * * * *` }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;

    logFlowEvent({
      flow: "pending_actions_drain",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { intervalMinutes: config.pendingActions.drainIntervalMinutes },
    });

    // ── Step 1: Fetch all orders with pending actions + emit all events ───
    const drainResult = await step.run("sweep-and-emit", async () => {
      const orders = await getAllPendingActionOrders();

      if (orders.length === 0) {
        return { count: 0, emitted: [], cleared: [] };
      }

      console.log(`[PendingActions] Drain sweep: ${orders.length} order(s) have pending actions`);

      const eventsToSend: Array<{ name: string; data: Record<string, unknown> }> = [];
      const clearedOrderIds: string[] = [];

      for (const order of orders) {
        const actions: PendingAction[] = order.pending_actions || [];
        if (actions.length === 0) continue;

        const hasCancelAction = actions.some((a) => a.action === "cancel");

        let emittedForOrder = 0;
        for (const action of actions) {
          // Cancel takes priority — skip fulfillment if cancel is also pending
          if (action.action === "fulfill" && hasCancelAction) {
            console.log(
              `[PendingActions] Skipping stacked fulfillment for ${order.shopify_order_name} — cancellation pending`
            );
            continue;
          }

          eventsToSend.push({
            name: action.eventName as string,
            data: {
              ...action.eventData,
              fromDrain: true,
            },
          });
          emittedForOrder++;
        }

        if (emittedForOrder > 0 || hasCancelAction) {
          const clearKey =
            (order.shopify_order_id && String(order.shopify_order_id).trim()) ||
            (order.platform_order_id && String(order.platform_order_id).trim()) ||
            "";
          if (clearKey) {
            clearedOrderIds.push(clearKey);
          } else {
            console.warn(
              `[PendingActions] Skip bulk-clear key for order name=${order.shopify_order_name} — no shopify_order_id or platform_order_id`
            );
          }
        }
      }

      if (eventsToSend.length > 0) {
        // Single batch send — one network call for all events across all orders
        await inngest.send(eventsToSend as any);
        console.log(
          `[PendingActions] Batch-sent ${eventsToSend.length} event(s) for ${clearedOrderIds.length} order(s)`
        );
      }

      return {
        count: orders.length,
        emitted: eventsToSend.map((e) => e.name),
        cleared: clearedOrderIds,
      };
    });

    if (drainResult.cleared.length === 0) {
      logFlowEvent({
        flow: "pending_actions_drain",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { status: "idle", processed: 0 },
      });
      return { status: "idle", processed: 0 };
    }

    // ── Step 2: Bulk-clear all processed orders in one update ─────────────
    await step.run("bulk-clear", async () => {
      await clearPendingActionsBatch(drainResult.cleared);
    });

    logFlowEvent({
      flow: "pending_actions_drain",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        processed: drainResult.count,
        eventsEmitted: drainResult.emitted.length,
        ordersCleared: drainResult.cleared.length,
      },
    });

    return {
      status: "drained",
      processed: drainResult.count,
      eventsEmitted: drainResult.emitted.length,
      ordersCleared: drainResult.cleared.length,
    };
  }
);
