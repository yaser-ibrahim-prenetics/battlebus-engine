import { orderChannel } from "../../channels";
import { logFlowEvent } from "@/lib/services/flow-logs";

export type PublishStatus = (
  stepName: string,
  status: "running" | "completed" | "failed" | "skipped",
  message?: string,
  data?: Record<string, unknown>
) => Promise<void>;

export type PublishResult = (
  status: "success" | "failed" | "skipped",
  resultData?: {
    d365OrderNumber?: string;
    gpsOrderNo?: string;
    warehouse?: string;
    error?: string;
  }
) => Promise<void>;

export function createOrderRealtimePublisher(params: {
  publish: unknown;
  shopifyOrderId: string;
  shopifyOrderName: string;
  inngestIdempotencyKey: string;
  inngestRunId: string;
}) {
  const channel = orderChannel({ orderName: params.shopifyOrderName });
  const stepStartTimes = new Map<string, number>();
  const stepDurations: Array<{ step: string; durationMs: number }> = [];

  const publishToRealtime = async (target: unknown, payload: Record<string, unknown>) => {
    if (typeof params.publish === "function") await params.publish(target, payload);
  };

  const publishStatus: PublishStatus = async (stepName, status, message, data) => {
    const now = Date.now();
    let durationMs: number | undefined;
    if (status === "running") {
      stepStartTimes.set(stepName, now);
    } else if (status === "completed" || status === "failed") {
      const startedAt = stepStartTimes.get(stepName);
      if (startedAt) {
        durationMs = now - startedAt;
        stepStartTimes.delete(stepName);
        stepDurations.push({ step: stepName, durationMs });
      }
    }

    try {
      logFlowEvent({
        level: status === "failed" ? "error" : status === "skipped" ? "warn" : "info",
        flow: "order_paid",
        step: stepName,
        runId: params.inngestRunId,
        shopifyOrderId: params.shopifyOrderId,
        shopifyOrderName: params.shopifyOrderName,
        status,
        durationMs,
        errorMessage: status === "failed" ? message : undefined,
        payload: data,
      });
      await publishToRealtime(channel.status, {
        orderName: params.shopifyOrderName,
        inngestIdempotencyKey: params.inngestIdempotencyKey,
        inngestRunId: params.inngestRunId,
        step: stepName,
        status,
        message,
        data,
        durationMs,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[Realtime] Failed to publish status: ${error}`);
    }
  };

  const publishResult: PublishResult = async (status, resultData) => {
    try {
      logFlowEvent({
        level: status === "failed" ? "error" : status === "skipped" ? "warn" : "info",
        flow: "order_paid",
        step: "result",
        runId: params.inngestRunId,
        shopifyOrderId: params.shopifyOrderId,
        shopifyOrderName: params.shopifyOrderName,
        d365OrderNumber: resultData?.d365OrderNumber,
        status,
        errorMessage: resultData?.error,
        payload: resultData,
      });
      await publishToRealtime(channel.result, {
        orderName: params.shopifyOrderName,
        inngestIdempotencyKey: params.inngestIdempotencyKey,
        inngestRunId: params.inngestRunId,
        status,
        ...resultData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[Realtime] Failed to publish result: ${error}`);
    }
  };

  return { publishStatus, publishResult, stepDurations };
}
