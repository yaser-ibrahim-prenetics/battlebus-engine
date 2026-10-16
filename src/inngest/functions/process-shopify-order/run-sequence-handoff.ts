import type { ShopifyOrderPayload, RunSequenceStage } from "../../events";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { advanceRunSequence } from "@/lib/services/run-sequence";

export function createOrderRunSequenceHandoff(params: {
  incomingRunSequence: RunSequenceStage[];
  getOrder: () => ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyStore: string;
  inngestRunId: string;
  inngestIdempotencyKey: string;
}) {
  return async (resultPayload: Record<string, unknown>): Promise<void> => {
    if (params.incomingRunSequence.length === 0) return;
    try {
      const order = params.getOrder();
      await advanceRunSequence({
        shopifyOrderId: params.shopifyOrderId,
        shopifyOrderName: params.shopifyOrderName,
        completedStage: {
          id: `order_creation-${params.inngestRunId}`,
          stage: "order_creation",
          eventName: "shopify/order.paid",
          status: "completed",
          runId: params.inngestRunId,
        },
        remaining: params.incomingRunSequence,
        orderJson: order,
        fulfillments: Array.isArray((order as any)?.fulfillments)
          ? ((order as any).fulfillments as any[])
          : [],
        shopifyStore: params.shopifyStore,
        inngestRunId: params.inngestRunId,
        inngestIdempotencyKey: params.inngestIdempotencyKey,
      });
      logFlowEvent({
        flow: "order_paid",
        step: "sequenced-handoff",
        status: "completed",
        runId: params.inngestRunId,
        shopifyOrderId: params.shopifyOrderId,
        shopifyOrderName: params.shopifyOrderName,
        payload: { ...resultPayload, nextStage: params.incomingRunSequence[0]?.stage },
      });
    } catch (error) {
      console.warn(
        `[RunSequence] Failed to advance after order_creation for ${params.shopifyOrderName}: ${error}`
      );
    }
  };
}
