// ============================================================================
// DRAIN PENDING ACTIONS — DURABLE LEASED SWEEP
// ============================================================================
// Workers claim a bounded set of normalized actions with PostgreSQL row locks.
// Publication reuses each stable action ID, and acknowledgement updates only the
// exact action/lease pair. Expired leases are safe to reclaim and republish.

import { inngest } from "../client";
import {
  claimPendingActions,
  completePendingAction,
  importLegacyPendingActions,
  retryPendingAction,
  type ClaimedPendingAction,
} from "@/lib/services/pending-actions";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/flow-logs";

type DrainResult = {
  claimed: number;
  published: number;
  failed: number;
  acknowledgementFailed: number;
};

type DrainContext = {
  step: {
    run(name: string, callback: () => unknown | Promise<unknown>): Promise<unknown>;
  };
  event: {
    id?: string;
    data?: {
      shopifyOrderId?: string;
      shopifyOrderName?: string;
    };
  };
};

function eventFor(action: ClaimedPendingAction) {
  return {
    id: `pending-action-${action.actionId}`,
    name: action.eventName,
    data: {
      ...action.eventData,
      fromDrain: true,
      pendingActionId: action.actionId,
    },
  };
}

async function releaseFailedPublication(actions: ClaimedPendingAction[]): Promise<number> {
  const results = await Promise.allSettled(actions.map((action) => retryPendingAction(action)));
  return results.filter((result) => result.status === "rejected").length;
}

async function acknowledgePublication(actions: ClaimedPendingAction[]): Promise<number> {
  const results = await Promise.allSettled(actions.map((action) => completePendingAction(action)));
  return results.filter((result) => result.status === "rejected").length;
}

async function claimAndPublish(): Promise<DrainResult> {
  const actions = await claimPendingActions();
  if (actions.length === 0) {
    return { claimed: 0, published: 0, failed: 0, acknowledgementFailed: 0 };
  }

  try {
    await inngest.send(actions.map(eventFor));
  } catch {
    // Provider errors may include credentials or endpoint data. Persist/log only
    // a fixed message; stable event IDs make uncertain publication safe to retry.
    const releaseFailed = await releaseFailedPublication(actions);
    console.error(
      `[PendingActions] Batch publication failed claimed=${actions.length} leaseReleaseFailed=${releaseFailed}`
    );
    return {
      claimed: actions.length,
      published: 0,
      failed: actions.length,
      acknowledgementFailed: releaseFailed,
    };
  }

  const acknowledgementFailed = await acknowledgePublication(actions);
  if (acknowledgementFailed > 0) {
    console.error(
      `[PendingActions] Publication acknowledgement failed count=${acknowledgementFailed}`
    );
  }
  return {
    claimed: actions.length,
    published: actions.length,
    failed: 0,
    acknowledgementFailed,
  };
}

export async function runDrainPendingActions({ step, event }: DrainContext) {
  if (config.features.dryRunMode) {
    return { status: "disabled", reason: "dry-run", processed: 0 };
  }

  const flowStart = Date.now();
  const runId = event.id;

  logFlowEvent({
    flow: "pending_actions_drain",
    step: "start",
    status: "started",
    runId,
    shopifyOrderId: event.data?.shopifyOrderId,
    shopifyOrderName: event.data?.shopifyOrderName,
    payload: {
      intervalMinutes: config.pendingActions.drainIntervalMinutes,
      claimBatchSize: config.pendingActions.claimBatchSize,
    },
  });

  const legacy = (await step.run("import-legacy-actions", importLegacyPendingActions)) as Awaited<
    ReturnType<typeof importLegacyPendingActions>
  >;
  const result = (await step.run("claim-and-publish", claimAndPublish)) as Awaited<
    ReturnType<typeof claimAndPublish>
  >;

  const status = result.claimed === 0 ? "idle" : "drained";
  logFlowEvent({
    flow: "pending_actions_drain",
    step: "done",
    status: "completed",
    runId,
    durationMs: Date.now() - flowStart,
    shopifyOrderId: event.data?.shopifyOrderId,
    shopifyOrderName: event.data?.shopifyOrderName,
    payload: {
      status,
      legacyImported: legacy.imported,
      legacyOrdersCleared: legacy.clearedOrders,
      ...result,
    },
  });

  return {
    status,
    processed: result.claimed,
    eventsEmitted: result.published,
    failed: result.failed,
    acknowledgementFailed: result.acknowledgementFailed,
    legacyImported: legacy.imported,
  };
}

export const drainPendingActions = inngest.createFunction(
  {
    id: "drain-pending-actions",
    name: "Drain Pending Lifecycle Actions",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    // PostgreSQL row locks and leases make overlapping recovery sweeps safe.
    concurrency: { limit: 2 },
    triggers: [{ cron: `*/${config.pendingActions.drainIntervalMinutes} * * * *` }],
  },
  runDrainPendingActions
);
