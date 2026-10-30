import { ChannelLiftError, channelLiftDigest } from "@/lib/channel-lift/model";
import { sendMetaChannelLiftBatch } from "@/lib/clients/meta-conversions";
import { config } from "@/lib/config";
import type { MetaChannelLiftRunRequestedEvent } from "@/inngest/events";
import { inngest } from "@/inngest/client";
import {
  prepareChannelLiftDeliveryBatch,
  prepareChannelLiftReport,
} from "@/lib/services/channel-lift/report";
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
        requestId: event.data.requestId,
        requestedBy: event.data.requestedBy,
        reasonCode: event.data.reasonCode,
        referenceId: event.data.referenceId,
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

      let attemptedEvents = reservation.run.attemptedEvents;
      let deliveredEvents = reservation.run.deliveredEvents;
      let confirmedEvents = 0;
      let startIndex = 0;
      for (const batch of evidence.deliveryBatches) {
        if (confirmedEvents + batch.eventCount > deliveredEvents) break;
        confirmedEvents += batch.eventCount;
        startIndex += 1;
      }
      if (confirmedEvents !== deliveredEvents || attemptedEvents > evidence.eligibleEvents) {
        throw new ChannelLiftError("delivery_progress_inconsistent");
      }

      const batchCount = evidence.deliveryBatches.length;
      let cumulativeEvents = evidence.deliveryBatches
        .slice(0, startIndex)
        .reduce((total, batch) => total + batch.eventCount, 0);
      for (let index = startIndex; index < batchCount; index += 1) {
        const batchEvidence = evidence.deliveryBatches[index];
        const fence = channelLiftDigest([
          evidence.configHash,
          evidence.snapshotHash,
          batchEvidence.digest,
        ]).slice(0, 16);
        cumulativeEvents += batchEvidence.eventCount;
        attemptedEvents = Math.max(attemptedEvents, cumulativeEvents);
        // Persist the logical attempt before the provider call so a timeout or
        // ambiguous receipt remains visible to operators.
        await step.run(`record-meta-attempt-${index}-${fence}`, () =>
          recordChannelLiftProgress({
            runId,
            batchCount: index + 1,
            attemptedEvents,
            deliveredEvents,
          })
        );
        const receipt = await step.run(`send-meta-batch-${index}-${fence}`, async () => {
          // Rebuild within each delivery checkpoint and re-run the database CAS
          // before every write. Any source/configuration drift fails closed.
          const replay = await prepareChannelLiftDeliveryBatch({
            reportingDate: event.data.reportingDate,
            eligibilityCutoffSeconds,
            expectedCounts: evidence.counts,
            batch: batchEvidence,
          });
          await recordChannelLiftPrepared({ runId, ...evidence });
          if (
            replay.configHash !== evidence.configHash ||
            replay.digest !== batchEvidence.digest
          ) {
            throw new ChannelLiftError("prepared_snapshot_changed");
          }
          if (replay.events.length !== batchEvidence.eventCount) {
            throw new ChannelLiftError("prepared_snapshot_changed");
          }
          return sendMetaChannelLiftBatch({
            datasetId: config.channelLift.metaDatasetId,
            accessToken: config.channelLift.metaAccessToken,
            events: replay.events,
          });
        });
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
        console.warn(
          `[ChannelLift] [${runId}] retrying reportingDate=${event.data.reportingDate} attempt=${attempt} errorCode=${errorCode(error)}`
        );
        throw error;
      }
      const code = errorCode(error);
      console.error(
        `[ChannelLift] [${runId}] run failed reportingDate=${event.data.reportingDate} attempt=${attempt} errorCode=${code}`
      );
      await step.run(`fail-channel-lift-${attempt}-${code}`, () => failChannelLiftRun(runId, code));
      return { status: "failed", runId, errorCode: code };
    }
  }
);
