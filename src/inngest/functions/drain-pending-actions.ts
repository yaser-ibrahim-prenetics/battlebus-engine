// ============================================================================
// DRAIN PENDING ACTIONS
// ============================================================================
// Replays stacked lifecycle events (fulfillment, cancellation, refund) that
// arrived before the D365/GPS order was fully created. Triggered by
// order/lifecycle.ready after process-shopify-order or process-backorder
// succeeds.

import { inngest } from "../client";
import {
  getPendingActions,
  clearPendingActions,
} from "@/lib/services/pending-actions";
import type { PendingAction } from "@/lib/services/pending-actions";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

export const drainPendingActions = inngest.createFunction(
  {
    id: "drain-pending-actions",
    name: "Drain Pending Lifecycle Actions",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: [{ limit: 1, key: "event.data.shopifyOrderId" }],
  },
  { event: "order/lifecycle.ready" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName } = event.data;

    const actions = await step.run("read-pending-actions", async () => {
      return getPendingActions(shopifyOrderId);
    });

    if (!actions || actions.length === 0) {
      return {
        status: "no_pending_actions",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    console.log(
      `[PendingActions] Draining ${actions.length} pending action(s) for ${shopifyOrderName}`
    );

    // Check if a cancel action is pending — if so, skip fulfillment events
    const hasCancelAction = actions.some(
      (a: PendingAction) => a.action === "cancel"
    );

    const emitted: string[] = [];

    for (const action of actions) {
      // Skip fulfillment if cancellation is also pending — cancel takes priority
      if (action.action === "fulfill" && hasCancelAction) {
        console.log(
          `[PendingActions] Skipping stacked fulfillment for ${shopifyOrderName} — cancellation pending`
        );
        continue;
      }

      await step.run(`emit-${action.action}-${action.createdAt}`, async () => {
        await inngest.send({
          name: action.eventName as any,
          data: {
            ...action.eventData,
            fromDrain: true,
          },
        });
      });

      emitted.push(action.action);
    }

    await step.run("clear-pending-actions", async () => {
      await clearPendingActions(shopifyOrderId);
    });

    return {
      status: "drained",
      shopifyOrderId,
      shopifyOrderName,
      actionsEmitted: emitted,
      totalActions: actions.length,
    };
  }
);
