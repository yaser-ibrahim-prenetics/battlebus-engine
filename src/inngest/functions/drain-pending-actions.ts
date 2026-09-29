import { randomUUID } from "crypto";

import { config } from "@/lib/config";
import { logFlowEvent } from "@/lib/services/flow-logs";
import {
  claimPendingActions,
  completePendingActions,
  type ClaimedPendingAction,
} from "@/lib/services/pending-actions";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

import { inngest } from "../client";

export async function runDrainPendingActions({ step, event }: { step: any; event: any }) {
  const flowStart = Date.now();
  const runId = (event as any).id;

  logFlowEvent({
    flow: "pending_actions_drain",
    step: "start",
    status: "started",
    runId,
    payload: { intervalMinutes: config.pendingActions.drainIntervalMinutes },
  });

  const claim = await step.run("claim-pending-actions", async () => {
    const claimToken = randomUUID();
    const actions = await claimPendingActions({ claimToken });
    return { claimToken, actions };
  });

  if (claim.actions.length === 0) {
    logFlowEvent({
      flow: "pending_actions_drain",
      step: "done",
      status: "completed",
      runId,
      durationMs: Date.now() - flowStart,
      payload: { status: "idle", processed: 0 },
    });
    return { status: "idle", processed: 0 };
  }

  const emitResult = await step.run("emit-claimed-actions", async () => {
    const actions = claim.actions as ClaimedPendingAction[];
    const ordersWithCancellation = new Set(
      actions.filter((action) => action.action === "cancel").map((action) => action.shopifyOrderId)
    );
    const published = actions.filter(
      (action) =>
        action.action !== "fulfill" || !ordersWithCancellation.has(action.shopifyOrderId)
    );
    const superseded = actions.filter(
      (action) =>
        action.action === "fulfill" && ordersWithCancellation.has(action.shopifyOrderId)
    );

    if (published.length > 0) {
      await inngest.send(
        published.map((action) => ({
          id: `pending-action-${action.id}`,
          name: action.eventName as any,
          data: {
            ...action.eventData,
            fromDrain: true,
            pendingActionId: action.id,
          },
        }))
      );
    }

    for (const action of superseded) {
      console.log(
        `[PendingActions] Superseding fulfillment ${action.id} for ${action.shopifyOrderName || action.shopifyOrderId} because cancellation is pending`
      );
    }

    console.log(
      `[PendingActions] Published ${published.length} durable event(s); superseded ${superseded.length}`
    );
    return {
      publishedIds: published.map((action) => action.id),
      supersededIds: superseded.map((action) => action.id),
      eventNames: published.map((action) => action.eventName),
    };
  });

  const completed = await step.run("complete-claimed-actions", async () => {
    return completePendingActions({
      claimToken: claim.claimToken,
      publishedIds: emitResult.publishedIds,
      supersededIds: emitResult.supersededIds,
    });
  });

  logFlowEvent({
    flow: "pending_actions_drain",
    step: "done",
    status: "completed",
    runId,
    durationMs: Date.now() - flowStart,
    payload: {
      processed: completed,
      eventsEmitted: emitResult.publishedIds.length,
      superseded: emitResult.supersededIds.length,
    },
  });

  return {
    status: "drained",
    processed: completed,
    eventsEmitted: emitResult.publishedIds.length,
    superseded: emitResult.supersededIds.length,
  };
}

export const drainPendingActions = inngest.createFunction(
  {
    id: "drain-pending-actions",
    name: "Drain Pending Lifecycle Actions",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 1 },
    triggers: [{ cron: `*/${config.pendingActions.drainIntervalMinutes} * * * *` }],
  },
  runDrainPendingActions
);
