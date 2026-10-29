import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send, claim, complete, importLegacy, retry } = vi.hoisted(() => ({
  send: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  importLegacy: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("../../client", () => ({
  inngest: {
    send,
    createFunction: vi.fn((_config, handler) => handler),
  },
}));

vi.mock("@/lib/services/pending-actions", () => ({
  claimPendingActions: claim,
  completePendingAction: complete,
  importLegacyPendingActions: importLegacy,
  retryPendingAction: retry,
}));

vi.mock("@/lib/services/flow-logs", () => ({
  logFlowEvent: vi.fn(),
}));

import { config } from "@/lib/config";
import { runDrainPendingActions } from "../drain-pending-actions";

const mutableConfig = config as unknown as {
  features: { dryRunMode: boolean };
  pendingActions: { durableQueueEnabled: boolean };
};

const cancellation = {
  actionId: "11111111-1111-4111-8111-111111111111",
  orderId: "1001",
  action: "cancel",
  eventName: "shopify/order.cancelled",
  eventData: { shopifyOrderId: "1001" },
  leaseToken: "22222222-2222-4222-8222-222222222222",
  attempts: 1,
};

function immediateStep() {
  const run = vi.fn(
    async (_name: string, callback: () => unknown | Promise<unknown>): Promise<unknown> =>
      await callback()
  );
  return {
    run,
  };
}

describe("runDrainPendingActions", () => {
  const originalDryRun = config.features.dryRunMode;
  const originalQueueEnabled = config.pendingActions.durableQueueEnabled;

  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.features.dryRunMode = false;
    mutableConfig.pendingActions.durableQueueEnabled = true;
    importLegacy.mockResolvedValue({ imported: 0, sourceOrders: 0 });
    claim.mockResolvedValue([]);
    complete.mockResolvedValue(undefined);
    retry.mockResolvedValue(undefined);
    send.mockResolvedValue({ ids: [] });
  });

  afterEach(() => {
    mutableConfig.features.dryRunMode = originalDryRun;
    mutableConfig.pendingActions.durableQueueEnabled = originalQueueEnabled;
  });

  it("does not claim or import lifecycle actions in dry-run", async () => {
    mutableConfig.features.dryRunMode = true;
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "dry-run", data: {} } })
    ).resolves.toEqual({ status: "disabled", reason: "dry-run", processed: 0 });
    expect(step.run).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not claim or import before durable queue activation", async () => {
    mutableConfig.pendingActions.durableQueueEnabled = false;
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "disabled", data: {} } })
    ).resolves.toEqual({
      status: "disabled",
      reason: "durable-queue-disabled",
      processed: 0,
    });
    expect(step.run).not.toHaveBeenCalled();
  });

  it("imports legacy rows before claiming normalized actions", async () => {
    importLegacy.mockResolvedValue({ imported: 2, sourceOrders: 1 });
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "idle", data: {} } })
    ).resolves.toMatchObject({ status: "idle", processed: 0, legacyImported: 2 });
    expect(step.run.mock.calls.map(([name]) => name)).toEqual([
      "import-legacy-actions",
      "claim-and-publish",
    ]);
  });

  it("publishes with the stable action ID and acknowledges the exact lease", async () => {
    claim.mockResolvedValue([cancellation]);
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "publish", data: {} } })
    ).resolves.toMatchObject({
      status: "drained",
      processed: 1,
      eventsEmitted: 1,
      failed: 0,
    });

    expect(send).toHaveBeenCalledWith([
      {
        id: `pending-action-${cancellation.actionId}`,
        name: cancellation.eventName,
        data: {
          ...cancellation.eventData,
          fromDrain: true,
          pendingActionId: cancellation.actionId,
        },
      },
    ]);
    expect(complete).toHaveBeenCalledWith(cancellation);
    expect(retry).not.toHaveBeenCalled();
  });

  it("releases every claimed lease after an uncertain batch publication", async () => {
    const second = {
      ...cancellation,
      actionId: "33333333-3333-4333-8333-333333333333",
      leaseToken: "44444444-4444-4444-8444-444444444444",
    };
    claim.mockResolvedValue([cancellation, second]);
    send.mockRejectedValue(new Error("secret-bearing provider response"));
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "publish-failed", data: {} } })
    ).resolves.toMatchObject({ processed: 2, eventsEmitted: 0, failed: 2 });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith(cancellation);
    expect(retry).toHaveBeenCalledWith(second);
    expect(complete).not.toHaveBeenCalled();
  });

  it("leaves a published action reclaimable when acknowledgement fails", async () => {
    claim.mockResolvedValue([cancellation]);
    complete.mockRejectedValue(new Error("database unavailable"));
    const step = immediateStep();

    await expect(
      runDrainPendingActions({ step, event: { id: "ack-failed", data: {} } })
    ).resolves.toMatchObject({
      processed: 1,
      eventsEmitted: 1,
      acknowledgementFailed: 1,
    });
    expect(retry).not.toHaveBeenCalled();
  });
});
