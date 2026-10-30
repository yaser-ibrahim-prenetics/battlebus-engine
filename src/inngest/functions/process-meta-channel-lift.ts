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

function errorCode(error: unknown): string {
  return error instanceof ChannelLiftError && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "channel_lift_failure";
}

export const processMetaChannelLift = inngest.createFunction(
  {
    id: "process-meta-channel-lift",
    name: "Process Meta Channel Lift",
    idempotency:
      "event.data.requestId + ':' + event.data.reportingDate + ':' + event.data.mode",
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

      const eligibilityCutoffSeconds = reservation.run.eligibilityCutoffSeconds;
      // Provider reads stay inside a durable step, while only aggregate evidence
      // leaves the closure. Inngest never persists the customer payload.
      const evidence = await step.run("prepare-channel-lift-evidence", async () => {
        const prepared = await prepareChannelLiftReport(
          event.data.reportingDate,
          eligibilityCutoffSeconds
        );
        await recordChannelLiftPrepared({ runId, ...prepared.evidence });
        return prepared.evidence;
      });

      if (event.data.mode === "dry_run") {
        await step.run("complete-channel-lift-dry-run", () =>
          completeChannelLiftRun(runId, "dry_run")
        );
        return {
          status: "dry_run_completed",
          runId,
          reportingDate: event.data.reportingDate,
          eligibleEvents: evidence.eligibleEvents,
        };
      }

      let attemptedEvents = 0;
      let deliveredEvents = 0;
      const batchCount = Math.ceil(evidence.eligibleEvents / 500);
      for (let index = 0; index < batchCount; index += 1) {
        const fence = channelLiftDigest([evidence.configHash, evidence.snapshotHash]).slice(0, 16);
        const receipt = await step.run(`send-meta-batch-${index}-${fence}`, async () => {
          // Rebuild within each delivery checkpoint and re-run the database CAS
          // before every write. Any source/configuration drift fails closed.
          const replay = await prepareChannelLiftReport(
            event.data.reportingDate,
            eligibilityCutoffSeconds
          );
          await recordChannelLiftPrepared({ runId, ...replay.evidence });
          if (
            replay.evidence.configHash !== evidence.configHash ||
            replay.evidence.snapshotHash !== evidence.snapshotHash
          ) {
            throw new ChannelLiftError("prepared_snapshot_changed");
          }
          const batch = replay.events.slice(index * 500, (index + 1) * 500);
          const expectedBatchSize = Math.min(500, evidence.eligibleEvents - index * 500);
          if (batch.length !== expectedBatchSize) {
            throw new ChannelLiftError("prepared_snapshot_changed");
          }
          return sendMetaChannelLiftBatch({
            datasetId: config.channelLift.metaDatasetId,
            accessToken: config.channelLift.metaAccessToken,
            events: batch,
          });
        });
        const expectedBatchSize = Math.min(500, evidence.eligibleEvents - index * 500);
        attemptedEvents += expectedBatchSize;
        deliveredEvents += receipt.eventsReceived;
        await step.run(`record-meta-batch-${index}-${fence}`, () =>
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
        batchCount,
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
