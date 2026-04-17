// ============================================================================
// RUN SEQUENCE HELPERS
// ============================================================================
// Sequenced reruns: when an order needs multiple Inngest runs in order
// (e.g. order creation → fulfillment replay), we propagate a `runSequence`
// array through events. Each handler calls `advanceRunSequence` on success,
// which dispatches the next pending stage and persists progress to the Hub
// for UI tracking via `orders.state.runSequence`.

import { inngest } from "@/inngest/client";
import * as csPlatform from "@/lib/clients/cs-platform";
import type {
  RunSequenceStage,
  ShopifyOrderPayload,
  ShopifyFulfillment,
} from "@/inngest/events";

export type AdvanceRunSequenceParams = {
  /** Shopify order id used by the Hub `orders` table. */
  shopifyOrderId: string;
  shopifyOrderName: string;
  /** Stage that just finished (or `undefined` if this is the initial dispatch). */
  completedStage?: RunSequenceStage;
  /** Remaining stages, in dispatch order. The first is dispatched here. */
  remaining: RunSequenceStage[];
  /** Hub will need an order/fulfillment payload to replay these stages. */
  orderJson?: ShopifyOrderPayload | null;
  fulfillments?: ShopifyFulfillment[] | null;
  shopifyStore?: string;
  /** Carried through for status_update CS Platform calls. */
  inngestRunId?: string;
  inngestIdempotencyKey?: string;
  /** Stages already completed in this chain — used to render full timeline. */
  history?: RunSequenceStage[];
};

const nowIso = () => new Date().toISOString();

/**
 * Build the runSequence snapshot to persist on the order for UI tracking.
 * Marks `completed`/`in_progress` based on which stage is being dispatched.
 */
function buildRunSequenceSnapshot(
  history: RunSequenceStage[],
  inFlight: RunSequenceStage | undefined,
  pending: RunSequenceStage[]
): RunSequenceStage[] {
  const completed = history.map((s) => ({
    ...s,
    status: s.status ?? "completed",
    completedAt: s.completedAt ?? nowIso(),
  }));
  const active = inFlight
    ? [
        {
          ...inFlight,
          status: "in_progress" as const,
          dispatchedAt: inFlight.dispatchedAt ?? nowIso(),
        },
      ]
    : [];
  const queued = pending.map((s) => ({ ...s, status: s.status ?? "pending" }));
  return [...completed, ...active, ...queued];
}

/**
 * Advance the run sequence for an order: dispatch the next stage if any,
 * and persist the updated snapshot to the Hub for UI tracking.
 *
 * Safe to call when there are no remaining stages — it will simply update
 * the order's state.runSequence to mark the chain as completed.
 */
export async function advanceRunSequence(
  params: AdvanceRunSequenceParams
): Promise<{ dispatched: RunSequenceStage | null; snapshot: RunSequenceStage[] }> {
  const {
    shopifyOrderId,
    shopifyOrderName,
    completedStage,
    remaining,
    orderJson,
    fulfillments,
    shopifyStore,
    inngestRunId,
    inngestIdempotencyKey,
    history = [],
  } = params;

  const fullHistory = completedStage
    ? [
        ...history,
        {
          ...completedStage,
          status: "completed" as const,
          completedAt: completedStage.completedAt ?? nowIso(),
          runId: completedStage.runId ?? inngestRunId,
        },
      ]
    : history;

  if (remaining.length === 0) {
    const snapshot = buildRunSequenceSnapshot(fullHistory, undefined, []);
    await csPlatform.sendOrderUpdate(
      {
        id: shopifyOrderId,
        name: shopifyOrderName,
        shopifyOrderId,
        shopifyOrderName,
        state: { runSequence: snapshot },
      },
      { inngestIdempotencyKey, inngestRunId }
    );
    return { dispatched: null, snapshot };
  }

  const [nextStage, ...rest] = remaining;
  const dispatchedStage: RunSequenceStage = {
    ...nextStage,
    status: "in_progress",
    dispatchedAt: nowIso(),
  };

  if (nextStage.eventName === "shopify/order.paid") {
    if (!orderJson) {
      throw new Error(
        `[RunSequence] Cannot dispatch shopify/order.paid for ${shopifyOrderName} — orderJson is required`
      );
    }
    await inngest.send({
      name: "shopify/order.paid",
      data: {
        shopifyOrderId,
        shopifyOrderName,
        shopifyStore: shopifyStore || "im8-battle-bus",
        orderJson,
        receivedAt: nowIso(),
        runSequence: rest,
        fromSequencedRetry: true,
      },
    });
  } else if (nextStage.eventName === "shopify/order.fulfilled") {
    if (!orderJson) {
      throw new Error(
        `[RunSequence] Cannot dispatch shopify/order.fulfilled for ${shopifyOrderName} — orderJson is required`
      );
    }
    await inngest.send({
      name: "shopify/order.fulfilled",
      data: {
        shopifyOrderId,
        shopifyOrderName,
        shopifyStore: shopifyStore || "im8-battle-bus",
        orderJson,
        fulfillments:
          fulfillments ??
          (Array.isArray((orderJson as any)?.fulfillments)
            ? ((orderJson as any).fulfillments as ShopifyFulfillment[])
            : []),
        receivedAt: nowIso(),
        runSequence: rest,
        fromSequencedRetry: true,
        fromBackorderRetry: true,
      },
    });
  } else if (nextStage.eventName === "backorder/retry") {
    await inngest.send({
      name: "backorder/retry",
      data: {
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: "",
        warehouse: "",
        retryCount: 0,
        triggeredBy: "manual",
        runSequence: rest,
      },
    });
  }

  const snapshot = buildRunSequenceSnapshot(fullHistory, dispatchedStage, rest);
  await csPlatform.sendOrderUpdate(
    {
      id: shopifyOrderId,
      name: shopifyOrderName,
      shopifyOrderId,
      shopifyOrderName,
      state: { runSequence: snapshot },
    },
    { inngestIdempotencyKey, inngestRunId }
  );

  return { dispatched: dispatchedStage, snapshot };
}

/**
 * Helper used by handlers at successful completion: extract the remaining
 * sequence (excluding the current stage which is the one we just finished)
 * from event data.
 */
export function extractRemainingSequence(
  event: { data?: { runSequence?: RunSequenceStage[] } } | undefined
): RunSequenceStage[] {
  const seq = event?.data?.runSequence;
  if (!Array.isArray(seq)) return [];
  return seq.filter((s): s is RunSequenceStage => !!s && typeof s === "object");
}
