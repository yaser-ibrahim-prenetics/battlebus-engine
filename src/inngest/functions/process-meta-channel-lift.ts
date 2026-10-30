import { ChannelLiftError, channelLiftDigest } from "@/lib/channel-lift/model";
import { sendMetaChannelLiftBatch } from "@/lib/clients/meta-conversions";
import { config } from "@/lib/config";
import type { MetaChannelLiftRunRequestedEvent } from "@/inngest/events";
import { inngest } from "@/inngest/client";
import { prepareChannelLiftReport } from "@/lib/services/channel-lift/report";
import {
  completeChannelLiftRun,
  failChannelLiftRun,
  recordChannelLiftPrepared,
  recordChannelLiftProgress,
  startChannelLiftRun,
} from "@/lib/services/channel-lift/runs";

const MAX_INNGEST_RETRIES = 4;

type ChannelLiftStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
};

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function errorCode(error: unknown): string {
  return error instanceof ChannelLiftError && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "channel_lift_failure";
}

export const processMetaChannelLift = inngest.createFunction(
  {
    id: "process-meta-channel-lift",
    name: "Process Meta Channel Lift",
    retries: MAX_INNGEST_RETRIES,
    concurrency: [{ limit: 1, key: "event.data.reportingDate" }, { limit: 2 }],
    triggers: [{ event: "meta.channel-lift/run.requested" }],
  },
  async ({
    event,
    step,
    attempt,
  }: {
    event: { id: string } & MetaChannelLiftRunRequestedEvent;
    step: ChannelLiftStep;
    attempt: number;
  }) => {
    if (!config.channelLift.enabled) return { status: "disabled" };

    const reservation = await step.run("reserve-channel-lift-run", () =>
      startChannelLiftRun({
        reportingDate: event.data.reportingDate,
        mode: event.data.mode,
        source: event.data.source,
        requestedBy: event.data.requestedBy,
        requestReason: event.data.requestReason,
      })
    );
    if (reservation.disposition !== "started") {
      return {
        status: reservation.disposition,
        runId: reservation.run.runId,
        reportingDate: reservation.run.reportingDate,
      };
    }

    const runId = reservation.run.runId;
    try {
      if (event.data.mode === "live" && !config.channelLift.sendEnabled) {
        throw new ChannelLiftError("live_send_disabled");
      }

      // Deliberately recomputed in memory on an Inngest replay. Customer identity
      // never becomes a persisted step result; the immutable snapshot hash guards
      // against provider data changing between invocations.
      const prepared = await prepareChannelLiftReport(event.data.reportingDate);
      await step.run("record-channel-lift-preparation", () =>
        recordChannelLiftPrepared({ runId, ...prepared.evidence })
      );

      if (event.data.mode === "dry_run") {
        await step.run("complete-channel-lift-dry-run", () =>
          completeChannelLiftRun(runId, "dry_run")
        );
        return {
          status: "dry_run_completed",
          runId,
          reportingDate: event.data.reportingDate,
          eligibleEvents: prepared.events.length,
        };
      }

      let attemptedEvents = 0;
      let deliveredEvents = 0;
      const batches = chunks(prepared.events, 500);
      for (const [index, batch] of batches.entries()) {
        const batchDigest = channelLiftDigest(batch.map((item) => item.event_id)).slice(0, 16);
        const receipt = await step.run(`send-meta-batch-${index}-${batchDigest}`, () =>
          sendMetaChannelLiftBatch({
            datasetId: config.channelLift.metaDatasetId,
            accessToken: config.channelLift.metaAccessToken,
            events: batch,
          })
        );
        attemptedEvents += batch.length;
        deliveredEvents += receipt.eventsReceived;
        await step.run(`record-meta-batch-${index}-${batchDigest}`, () =>
          recordChannelLiftProgress({
            runId,
            batchCount: index + 1,
            attemptedEvents,
            deliveredEvents,
          })
        );
      }

      await step.run("complete-channel-lift-live-run", () => completeChannelLiftRun(runId, "live"));
      return {
        status: "completed",
        runId,
        reportingDate: event.data.reportingDate,
        attemptedEvents,
        deliveredEvents,
        batchCount: batches.length,
      };
    } catch (error) {
      if (error instanceof ChannelLiftError && error.retryable && attempt < MAX_INNGEST_RETRIES) {
        throw error;
      }
      const code = errorCode(error);
      await step.run(`fail-channel-lift-${attempt}-${code}`, () => failChannelLiftRun(runId, code));
      return { status: "failed", runId, errorCode: code };
    }
  }
);
