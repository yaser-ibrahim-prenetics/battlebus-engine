import { config } from "@/lib/config";
import type { FulfillmentActionHousekeepingRequestedEvent } from "@/inngest/events";
import { runFulfillmentActionHousekeeping } from "@/lib/services/fulfillment-actions/housekeeping";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { inngest } from "@/inngest/client";

type HousekeepingStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  sendEvent(
    id: string,
    event: { id: string } & FulfillmentActionHousekeepingRequestedEvent
  ): Promise<unknown>;
};

type HousekeepingEvent = {
  id: string;
  name: string;
  data?: Partial<FulfillmentActionHousekeepingRequestedEvent["data"]>;
};

export const housekeepFulfillmentActions = inngest.createFunction(
  {
    id: "housekeep-fulfillment-actions",
    name: "Housekeep fulfillment actions",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 1 },
    triggers: [{ cron: "15 2 * * *" }, { event: "fulfillment-actions/housekeeping.requested" }],
  },
  async ({ event, step }: { event: HousekeepingEvent; step: HousekeepingStep }) => {
    if (!config.fulfillmentActionHousekeeping.enabled) {
      return { status: "disabled", deleted: 0, alertsEnqueued: 0, hasMore: false };
    }

    const requestedRoot = event.data?.rootRunId;
    const rootRunId =
      typeof requestedRoot === "string" && requestedRoot.length > 0 && requestedRoot.length <= 512
        ? requestedRoot
        : event.id;
    const requestedBatch = event.data?.batch;
    const batch =
      Number.isInteger(requestedBatch) && Number(requestedBatch) >= 0 ? Number(requestedBatch) : 0;
    const result = await step.run(`housekeep-batch-${batch}`, () =>
      runFulfillmentActionHousekeeping({
        retentionDays: config.fulfillmentActionHousekeeping.retentionDays,
        batchSize: config.fulfillmentActionHousekeeping.batchSize,
        unresolvedAlertHours: config.fulfillmentActionHousekeeping.unresolvedAlertHours,
        alertRepeatHours: config.fulfillmentActionHousekeeping.alertRepeatHours,
        alertBatchSize: config.fulfillmentActionHousekeeping.alertBatchSize,
      })
    );

    if (result.hasMore) {
      const nextBatch = batch + 1;
      await step.sleep(
        "wait-before-housekeeping-successor",
        `${config.fulfillmentActionHousekeeping.successorDelayMinutes}m`
      );
      await step.sendEvent("queue-housekeeping-successor", {
        id: `fulfillment-action-housekeeping:${rootRunId}:${nextBatch}`,
        name: "fulfillment-actions/housekeeping.requested",
        data: { rootRunId, batch: nextBatch },
      });
    }

    return {
      status: result.skipped
        ? "busy"
        : result.deleted || result.alertsEnqueued
          ? "processed"
          : "idle",
      batch,
      ...result,
    };
  }
);
