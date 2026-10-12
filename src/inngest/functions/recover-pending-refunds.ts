import { randomUUID } from "crypto";

import { config } from "@/lib/config";
import { logFlowEvent } from "@/lib/services/flow-logs";
import {
  claimRefundRecoveries,
  loadRefundRecoveryDispatches,
} from "@/lib/services/refund-operations";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

import { inngest } from "../client";

export async function runRecoverPendingRefunds({ step, event }: { step: any; event: any }) {
  const runId = String(event?.id || "");
  const flowStart = Date.now();

  const claim = await step.run("claim-refund-recoveries", async () => {
    const claimToken = randomUUID();
    const result = await claimRefundRecoveries({ claimToken });
    return { claimToken, ...result };
  });

  if (claim.claimedCount === 0) {
    if (claim.deadLetteredCount > 0) {
      logFlowEvent({
        flow: "refund_recovery",
        step: "dead_letter",
        status: "failed",
        runId,
        durationMs: Date.now() - flowStart,
        payload: { deadLettered: claim.deadLetteredCount },
      });
    }
    return {
      status: "idle",
      dispatched: 0,
      deadLettered: claim.deadLetteredCount,
    };
  }

  const dispatch = await step.run("dispatch-refund-recoveries", async () => {
    const recoveries = await loadRefundRecoveryDispatches({ claimToken: claim.claimToken });
    if (recoveries.length > 0) {
      await inngest.send(
        recoveries.map((recovery) => ({
          id: `refund-recovery-${recovery.refundId}-${recovery.attempts}`,
          name: recovery.eventName as any,
          data: {
            ...recovery.eventData,
            refundRecoveryToken: claim.claimToken,
            refundRecoveryAttempt: recovery.attempts,
          },
        }))
      );
    }

    return {
      dispatched: recoveries.length,
      refundIds: recoveries.map((recovery) => recovery.refundId),
    };
  });

  logFlowEvent({
    flow: "refund_recovery",
    step: "dispatch",
    status: "completed",
    runId,
    durationMs: Date.now() - flowStart,
    payload: {
      claimed: claim.claimedCount,
      deadLettered: claim.deadLetteredCount,
      dispatched: dispatch.dispatched,
      refundIds: dispatch.refundIds,
    },
  });

  return { status: "dispatched", ...dispatch };
}

export const recoverPendingRefunds = inngest.createFunction(
  {
    id: "recover-pending-refunds",
    name: "Recover Refunds Waiting for Orders",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 1 },
    triggers: [{ cron: `*/${config.pendingActions.drainIntervalMinutes} * * * *` }],
  },
  runRecoverPendingRefunds
);
