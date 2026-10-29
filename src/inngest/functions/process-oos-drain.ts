import { inngest } from "../client";
import { config } from "@/lib/config";
import { executeOosDrain } from "@/lib/services/oos-recovery/drain";
import {
  claimOosDrainRequest,
  finishOosDrainRequest,
  retryOosDrainRequest,
  submitOosDrainRequest,
} from "@/lib/services/oos-recovery/requests";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

type OosDrainStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
};

function safeErrorCode(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown };
  const name =
    typeof candidate?.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.name)
      ? candidate.name
      : "drain_error";
  const code =
    typeof candidate?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  return [name, code].filter(Boolean).join(":");
}

export const processOosDrain = inngest.createFunction(
  {
    id: "process-oos-targeted-drain",
    name: "Process OOS Targeted Drain",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 1, key: "event.data.laneKey" }],
    triggers: [{ event: "oos/drain.requested" }],
  },
  async ({ event, step }: { event: { data: { requestId?: string } }; step: OosDrainStep }) => {
    if (!config.oosRecovery.enabled) return { status: "disabled" };
    const requestId = event.data?.requestId;
    if (typeof requestId !== "string" || !requestId) {
      return { status: "rejected", reason: "missing_request_id" };
    }
    // Claim directly on every Inngest attempt. A released retry must receive a fresh exact lease.
    const request = await claimOosDrainRequest(requestId, config.oosRecovery.leaseSeconds);
    if (!request) return { status: "stale_or_already_running" };
    try {
      const result = await step.run(`execute-oos-drain-${request.id}-${request.attemptCount}`, () =>
        executeOosDrain(request)
      );
      const successorId = await finishOosDrainRequest({
        request,
        resultEvidence: {
          examinedOrders: result.examinedOrders,
          selectedOrders: result.selectedOrders,
          selectedDependencies: result.selectedDependencies,
          manualReviewExpired: result.manualReviewExpired,
          queuedKeys: result.queuedKeys,
          dryRun: request.dryRun,
        },
      });
      return { status: "completed", ...result, successorId };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (request.attemptCount >= config.oosRecovery.maxAttempts) {
        const successorId = await finishOosDrainRequest({
          request,
          resultEvidence: { dryRun: request.dryRun, terminal: true },
          errorCode,
        });
        return { status: "failed", errorCode, successorId };
      }
      await retryOosDrainRequest(request, errorCode);
      throw error;
    }
  }
);

export const scheduleOosDrainSweep = inngest.createFunction(
  {
    id: "schedule-oos-recovery-sweep",
    name: "Schedule OOS Recovery Sweep",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    triggers: [{ cron: `*/${config.oosRecovery.sweepIntervalMinutes} * * * *` }],
  },
  async () => {
    if (!config.oosRecovery.enabled) return { status: "disabled" };
    const submitted = await submitOosDrainRequest({
      mode: "sweep",
      dryRun: false,
      batchLimit: config.oosRecovery.claimBatchSize,
    });
    return {
      status: submitted.created ? "queued" : "coalesced",
      requestId: submitted.request.id,
    };
  }
);
