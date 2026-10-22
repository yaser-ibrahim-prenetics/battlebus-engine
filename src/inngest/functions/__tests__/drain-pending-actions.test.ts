import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { getAllPendingActionOrders } from "@/lib/services/pending-actions";
import { runDrainPendingActions } from "../drain-pending-actions";

vi.mock("@/lib/services/pending-actions", () => ({
  getAllPendingActionOrders: vi.fn(),
  clearPendingActionsBatch: vi.fn(),
}));

vi.mock("@/lib/services/flow-logs", () => ({
  logFlowEvent: vi.fn(),
}));

describe("runDrainPendingActions", () => {
  const originalEnabled = config.csPlatform.enabled;
  const originalDryRun = config.features.dryRunMode;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    config.csPlatform.enabled = originalEnabled;
    config.features.dryRunMode = originalDryRun;
  });

  it("does not drain or clear lifecycle actions in dry-run even with Hub connected", async () => {
    config.csPlatform.enabled = true;
    config.features.dryRunMode = true;
    const step = { run: vi.fn() };
    const result = await runDrainPendingActions({ step, event: { id: "dry-run", data: {} } });
    expect(result).toEqual({ status: "disabled", reason: "dry-run", processed: 0 });
    expect(step.run).not.toHaveBeenCalled();
    expect(getAllPendingActionOrders).not.toHaveBeenCalled();
  });

  it("does not call Battle Hub when CS Platform is disabled", async () => {
    config.csPlatform.enabled = false;
    const step = { run: vi.fn() };

    const result = await runDrainPendingActions({
      step,
      event: { id: "test-run", data: {} },
    });

    expect(result).toEqual({
      status: "disabled",
      reason: "cs-platform-disabled",
      processed: 0,
    });
    expect(step.run).not.toHaveBeenCalled();
    expect(getAllPendingActionOrders).not.toHaveBeenCalled();
  });
});
