import { withSegmentPublication } from "./publication";
import { inngest } from "@/inngest/client";
import type { ShopifyOrderPayload } from "@/inngest/events";
import * as hub from "@/lib/clients/cs-platform";
import { logFlowEventSync } from "../flow-logs";
import { readPlan } from "./store";

export async function reportSegmentProgress(
  shop: string,
  order: ShopifyOrderPayload,
  error?: unknown
) {
  return withSegmentPublication(shop, String(order.id), async () => {
    const stored = await readPlan(shop, String(order.id));
    if (!stored) return;
    const segments = stored.plan.segments.map((segment) => ({
      ...segment,
      ...stored.progress[String(segment.index)],
    }));
    const completed = !error && segments.every((segment) => segment.completed);
    const first = segments[0];
    const errorMessage = error
      ? "Segment processing requires recovery; inspect the durable provider action ledger before replay"
      : null;
    await hub.sendOrderCreated({
      id: String(order.id),
      name: order.name,
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      orderJson: order,
      warehouse: first.warehouse,
      d365OrderNumber: first.salesOrderNumber,
      gpsOrderId: first.gpsOrderId,
      state: { orderSegments: segments },
    });
    await hub.sendOrderUpdate({
      id: String(order.id),
      name: order.name,
      status: completed ? "completed" : error ? "failed" : "processing",
      processingStatus: completed ? "completed" : error ? "failed" : "processing",
      d365SyncStatus: completed ? "synced" : "pending",
      lastError: errorMessage,
      lastErrorType: error ? "segment_recovery" : null,
      state: {
        orderSegments: segments,
        failureContext: error
          ? { retryMode: "gps_outbound", failureStage: "order_creation" }
          : null,
      },
    });
    await logFlowEventSync({
      flow: "order_paid",
      step: "order_segments",
      status: completed ? "completed" : error ? "failed" : "started",
      level: error ? "error" : "info",
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      payload: {
        segmentCount: segments.length,
        completedCount: segments.filter((segment) => segment.completed).length,
      },
    });
    if (error)
      await inngest.send({
        id: `segment-recovery-${order.id}-${stored.plan.inputHash}`,
        name: "backorder/created",
        data: {
          shopifyOrderId: String(order.id),
          shopifyOrderName: order.name,
          shopifyStore: shop,
          d365OrderNumber: first.salesOrderNumber || "",
          warehouse: first.warehouse,
          errorMessage: errorMessage!,
          errorType: "segment_recovery",
          failedSkus: [],
          retryCount: 0,
          maxRetries: 0,
          orderJson: order,
          createdAt: new Date().toISOString(),
          sourceEventName: "shopify/order.paid",
          failureStage: "order_creation",
          failureSystem: "gps",
          retryMode: "gps_outbound",
          backorderQueue: "sync",
        },
      });
  });
}
