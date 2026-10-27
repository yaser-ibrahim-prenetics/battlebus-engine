import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyRefundCreatedEvent } from "@/inngest/events";
const mocks = vi.hoisted(() => ({ decision: vi.fn(), getOrder: vi.fn(), dedupe: vi.fn() }));
vi.mock("../../client", () => ({
  inngest: { createFunction: (_options: unknown, handler: unknown) => handler },
}));
vi.mock("@/lib/services/refund-holds/decisions", () => ({ getRefundHoldDecision: mocks.decision }));
vi.mock("@/lib/clients/shopify", () => ({ getOrder: mocks.getOrder }));
vi.mock("@/lib/services/flow-logs", () => ({
  logFlowEvent: vi.fn(),
  hasCompletedRefundFlowLog: mocks.dedupe,
}));
import { config } from "@/lib/config";
import { processRefund } from "../process-refund";

function fixture() {
  return {
    shopifyStore: "fixture.myshopify.com",
    shopifyOrderId: "456",
    refundId: "123",
    refundJson: {
      id: 123,
      order_id: 456,
      created_at: "2026-10-20T00:00:00Z",
      refund_line_items: [],
    },
  } as ShopifyRefundCreatedEvent["data"];
}
function steps(sleepUntil = vi.fn(async () => {})) {
  return { run: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()), sleepUntil };
}
const run = processRefund as unknown as (args: {
  event: { data: ShopifyRefundCreatedEvent["data"] };
  step: ReturnType<typeof steps>;
  runId: string;
}) => Promise<unknown>;

describe("actual refund workflow hold gate", () => {
  const dryRun = config.features.dryRunMode;
  beforeEach(() => {
    vi.clearAllMocks();
    config.features.dryRunMode = false;
    mocks.dedupe.mockResolvedValue(false);
    mocks.getOrder.mockRejectedValue(new Error("provider stage reached"));
    mocks.decision.mockResolvedValue({
      waiting: true,
      holdUntil: "2026-10-21T00:00:00.000Z",
      unfulfilledLineCount: 1,
    });
  });
  afterEach(() => {
    config.features.dryRunMode = dryRun;
  });

  it.each([false, true])(
    "blocks providers until sleep finishes, including fromDrain=%s",
    async (fromDrain) => {
      let release!: () => void;
      let sleeping!: () => void;
      const started = new Promise<void>((resolve) => {
        sleeping = resolve;
      });
      const step = steps(
        vi.fn(() => {
          sleeping();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
      );
      const data = { ...fixture(), fromDrain };
      const pending = run({ event: { data }, step, runId: "test" });
      const assertion = expect(pending).rejects.toThrow("provider stage reached");
      await started;
      expect(mocks.getOrder).not.toHaveBeenCalled();
      expect(mocks.decision).toHaveBeenCalledWith(data);
      expect(step.sleepUntil).toHaveBeenCalledWith("wait-refund-hold", "2026-10-21T00:00:00.000Z");
      release();
      await assertion;
      expect(mocks.getOrder).toHaveBeenCalledTimes(1);
    }
  );
  it.each([false, true])(
    "skips a refund completed during the hold, including fromDrain=%s",
    async (fromDrain) => {
      let release!: () => void;
      let sleeping!: () => void;
      const started = new Promise<void>((resolve) => {
        sleeping = resolve;
      });
      const step = steps(
        vi.fn(() => {
          sleeping();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
      );
      const pending = run({ event: { data: { ...fixture(), fromDrain } }, step, runId: "held" });
      await started;
      expect(mocks.dedupe).toHaveBeenCalledTimes(1);
      expect(mocks.getOrder).not.toHaveBeenCalled();
      // Another accepted replay has now created the refund line and its
      // completion record is visible. The old check remains cached as false.
      mocks.dedupe.mockResolvedValue(true);
      release();
      await expect(pending).resolves.toMatchObject({ status: "already_processed" });
      expect(mocks.dedupe).toHaveBeenCalledTimes(2);
      expect(step.run.mock.calls.map(([name]) => name)).toContain("refund-dedupe-after-hold");
      expect(mocks.getOrder).not.toHaveBeenCalled();
    }
  );

  it("memoizes the post-hold check so later retries do not mistake their own work for a duplicate", async () => {
    const cached = new Map<string, unknown>();
    const step = steps();
    step.run.mockImplementation(async (name, fn) => {
      if (cached.has(name)) return cached.get(name);
      const result = await fn();
      cached.set(name, result);
      return result;
    });
    const args = { event: { data: fixture() }, step, runId: "same-run" };
    await expect(run(args)).rejects.toThrow("provider stage reached");
    expect(mocks.dedupe).toHaveBeenCalledTimes(2);
    expect(cached.get("refund-dedupe-after-hold")).toBe(false);
    // A later execution of this same run restores completed step results.
    mocks.dedupe.mockResolvedValue(true);
    await expect(run(args)).rejects.toThrow("provider stage reached");
    expect(mocks.dedupe).toHaveBeenCalledTimes(2);
    expect(mocks.getOrder).toHaveBeenCalledTimes(2);
  });

  it("never reaches providers if persistence fails", async () => {
    mocks.decision.mockRejectedValue(new Error("database unavailable"));
    const step = steps();
    await expect(run({ event: { data: fixture() }, step, runId: "test" })).rejects.toThrow(
      "database unavailable"
    );
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(step.sleepUntil).not.toHaveBeenCalled();
  });
  it.each([null, "2020-01-02T00:00:00.000Z"])(
    "does not sleep for an absent or expired hold %s",
    async (holdUntil) => {
      mocks.decision.mockResolvedValue({
        waiting: false,
        holdUntil,
        unfulfilledLineCount: holdUntil ? 1 : 0,
      });
      const step = steps();
      await expect(run({ event: { data: fixture() }, step, runId: "test" })).rejects.toThrow(
        "provider stage reached"
      );
      expect(step.sleepUntil).not.toHaveBeenCalled();
    }
  );
  it("keeps dry-run and completed-refund paths free of hold writes and provider calls", async () => {
    config.features.dryRunMode = true;
    await expect(
      run({ event: { data: fixture() }, step: steps(), runId: "test" })
    ).resolves.toMatchObject({ status: "dry_run" });
    config.features.dryRunMode = false;
    mocks.dedupe.mockResolvedValue(true);
    await expect(
      run({ event: { data: fixture() }, step: steps(), runId: "test" })
    ).resolves.toMatchObject({ status: "already_processed" });
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });
});
