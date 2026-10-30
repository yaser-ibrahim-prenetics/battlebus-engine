import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  runHousekeeping: vi.fn(),
  settings: {
    enabled: true,
    retentionDays: 90,
    batchSize: 100,
    unresolvedAlertHours: 24,
    alertRepeatHours: 24,
    alertBatchSize: 100,
    successorDelayMinutes: 1,
  },
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (options: Record<string, unknown>, handler: unknown) => {
      mocks.options = options;
      return handler;
    },
  },
}));
vi.mock("@/lib/config", () => ({
  config: { fulfillmentActionHousekeeping: mocks.settings },
}));
vi.mock("@/lib/services/fulfillment-actions/housekeeping", () => ({
  runFulfillmentActionHousekeeping: mocks.runHousekeeping,
}));

import { housekeepFulfillmentActions } from "@/inngest/functions/housekeep-fulfillment-actions";

type Handler = (input: {
  event: { id: string; name: string; data?: { rootRunId?: string; batch?: number } };
  step: {
    run: <T>(id: string, handler: () => Promise<T>) => Promise<T>;
    sleep: ReturnType<typeof vi.fn>;
    sendEvent: ReturnType<typeof vi.fn>;
  };
}) => Promise<Record<string, unknown>>;

describe("fulfillment-action housekeeping workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.enabled = true;
  });

  function harness() {
    return {
      run: async <T>(_id: string, handler: () => Promise<T>) => handler(),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("runs daily and serializes cron, manual and successor invocations", () => {
    expect(mocks.options).toMatchObject({
      concurrency: { limit: 1 },
      triggers: [{ cron: "15 2 * * *" }, { event: "fulfillment-actions/housekeeping.requested" }],
    });
  });

  it("stays inert until the migration rollout flag is enabled", async () => {
    mocks.settings.enabled = false;
    const step = harness();
    await expect(
      (housekeepFulfillmentActions as unknown as Handler)({
        event: { id: "cron-run", name: "cron" },
        step,
      })
    ).resolves.toMatchObject({ status: "disabled", hasMore: false });
    expect(mocks.runHousekeeping).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("finishes without a successor when the bounded batch clears due work", async () => {
    mocks.runHousekeeping.mockResolvedValue({
      skipped: false,
      deleted: 3,
      aliasesDeleted: 2,
      evidenceDeleted: 1,
      alertsEnqueued: 1,
      hasMore: false,
    });
    const step = harness();
    await expect(
      (housekeepFulfillmentActions as unknown as Handler)({
        event: { id: "cron-run", name: "cron" },
        step,
      })
    ).resolves.toMatchObject({ status: "processed", batch: 0, deleted: 3 });
    expect(mocks.runHousekeeping).toHaveBeenCalledWith({
      retentionDays: 90,
      batchSize: 100,
      unresolvedAlertHours: 24,
      alertRepeatHours: 24,
      alertBatchSize: 100,
    });
    expect(step.sleep).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("creates exactly one short-delay successor when more due work remains", async () => {
    mocks.runHousekeeping.mockResolvedValue({
      skipped: false,
      deleted: 100,
      aliasesDeleted: 0,
      evidenceDeleted: 0,
      alertsEnqueued: 0,
      hasMore: true,
    });
    const step = harness();
    await (housekeepFulfillmentActions as unknown as Handler)({
      event: {
        id: "successor-run",
        name: "fulfillment-actions/housekeeping.requested",
        data: { rootRunId: "cron-root", batch: 4 },
      },
      step,
    });
    expect(step.sleep).toHaveBeenCalledWith("wait-before-housekeeping-successor", "1m");
    expect(step.sendEvent).toHaveBeenCalledWith("queue-housekeeping-successor", {
      id: "fulfillment-action-housekeeping:cron-root:5",
      name: "fulfillment-actions/housekeeping.requested",
      data: { rootRunId: "cron-root", batch: 5 },
    });
  });
});
