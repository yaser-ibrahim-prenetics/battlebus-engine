import { ChannelLiftError, channelLiftDigest, channelLiftRunId } from "@/lib/channel-lift/model";
import { sendMetaChannelLiftBatch } from "@/lib/clients/meta-conversions";
import { config } from "@/lib/config";
import type { MetaChannelLiftRunRequestedEvent } from "@/inngest/events";
import { inngest } from "@/inngest/client";
import {
  finalizeChannelLiftEvidence,
  prepareChannelLiftCandidateBatch,
  prepareChannelLiftDeliveryBatch,
  prepareChannelLiftPlan,
  type ChannelLiftDeliveryBatch,
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
    idempotency: "event.data.requestId + ':' + event.data.reportingDate + ':' + event.data.mode",
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

    const expectedRunId = channelLiftRunId(event.data.reportingDate, event.data.mode);
    if (
      reservation.run.runId !== expectedRunId ||
      reservation.run.reportingDate !== event.data.reportingDate ||
      reservation.run.mode !== event.data.mode ||
      reservation.acceptedSource !== event.data.source ||
      reservation.acceptedRequestId !== event.data.requestId
    ) {
      return { status: "reservation_mismatch", runId: reservation.run.runId };
    }

    const runId = reservation.run.runId;
    try {
      if (event.data.mode === "live" && !config.channelLift.sendEnabled) {
        throw new ChannelLiftError("live_send_disabled");
      }

      const eligibilityCutoffSeconds = reservation.run.eligibilityCutoffSeconds;
      const plan = await step.run("prepare-channel-lift-plan", () =>
        prepareChannelLiftPlan(event.data.reportingDate)
      );
      const preparedBatches: Array<{
        batch: ChannelLiftDeliveryBatch;
        exclusionCounts: Record<string, number>;
        configHash: string;
      }> = [];
      for (const [index, candidateBatch] of plan.candidateBatches.entries()) {
        const fence = channelLiftDigest([
          plan.extractionConfigHash,
          plan.extractionSnapshotHash,
          candidateBatch,
        ]).slice(0, 16);
        // Customer data exists only inside this bounded closure. Inngest persists
        // the payload-free descriptor returned from the step.
        const prepared = await step.run(
          `prepare-channel-lift-batch-${index}-${fence}`,
          async () => {
            const candidate = await prepareChannelLiftCandidateBatch({
              reportingDate: event.data.reportingDate,
              eligibilityCutoffSeconds,
              expectedCounts: plan.counts,
              expectedMappedPairs: plan.mappedPairs,
              expectedMappedSnapshotHash: plan.mappedSnapshotHash,
              candidateBatch,
            });
            return {
              batch: candidate.batch,
              exclusionCounts: candidate.exclusionCounts,
              configHash: candidate.configHash,
            };
          }
        );
        preparedBatches.push(prepared);
      }
      const evidence = await step.run("record-channel-lift-preparation", async () => {
        const finalized = finalizeChannelLiftEvidence({
          plan,
          preparedBatches,
          eligibilityCutoffSeconds,
        });
        await recordChannelLiftPrepared({ runId, ...finalized });
        return finalized;
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
      let confirmedPositiveBatches = 0;
      for (const batch of evidence.deliveryBatches.filter((item) => item.eventCount > 0)) {
        if (confirmedEvents + batch.eventCount > deliveredEvents) break;
        confirmedEvents += batch.eventCount;
        confirmedPositiveBatches += 1;
      }
      if (confirmedEvents !== deliveredEvents || attemptedEvents > evidence.eligibleEvents) {
        throw new ChannelLiftError("delivery_progress_inconsistent");
      }

      const batchCount = evidence.deliveryBatches.filter((item) => item.eventCount > 0).length;
      let cumulativeEvents = 0;
      let positiveBatchIndex = 0;
      for (let index = 0; index < evidence.deliveryBatches.length; index += 1) {
        const batchEvidence = evidence.deliveryBatches[index];
        const fence = channelLiftDigest([
          evidence.configHash,
          evidence.snapshotHash,
          batchEvidence.digest,
        ]).slice(0, 16);
        if (batchEvidence.eventCount === 0) {
          await step.run(`validate-empty-meta-batch-${index}-${fence}`, async () => {
            const replay = await prepareChannelLiftDeliveryBatch({
              reportingDate: event.data.reportingDate,
              eligibilityCutoffSeconds,
              expectedCounts: evidence.counts,
              expectedMappedPairs: evidence.mappedPairs,
              expectedMappedSnapshotHash: evidence.mappedSnapshotHash,
              batch: batchEvidence,
            });
            await recordChannelLiftPrepared({ runId, ...evidence });
            if (
              replay.configHash !== evidence.configHash ||
              replay.digest !== batchEvidence.digest ||
              replay.events.length !== 0
            ) {
              throw new ChannelLiftError("prepared_snapshot_changed");
            }
          });
          continue;
        }
        cumulativeEvents += batchEvidence.eventCount;
        if (positiveBatchIndex < confirmedPositiveBatches) {
          positiveBatchIndex += 1;
          continue;
        }
        attemptedEvents = Math.max(attemptedEvents, cumulativeEvents);
        // Persist the logical attempt before the provider call so a timeout or
        // ambiguous receipt remains visible to operators.
        await step.run(`record-meta-attempt-${index}-${fence}`, () =>
          recordChannelLiftProgress({
            runId,
            batchCount: positiveBatchIndex + 1,
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
            expectedMappedPairs: evidence.mappedPairs,
            expectedMappedSnapshotHash: evidence.mappedSnapshotHash,
            batch: batchEvidence,
          });
          await recordChannelLiftPrepared({ runId, ...evidence });
          if (replay.configHash !== evidence.configHash || replay.digest !== batchEvidence.digest) {
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
            batchCount: positiveBatchIndex + 1,
            attemptedEvents,
            deliveredEvents,
          })
        );
        positiveBatchIndex += 1;
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
