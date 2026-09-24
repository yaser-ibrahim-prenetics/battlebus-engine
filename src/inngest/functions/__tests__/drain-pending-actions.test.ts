import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { getAllPendingActionOrders } from "@/lib/services/pending-actions";
import { runDrainPendingActions } from "../drain-pending-actions";

vi.mock("@/lib/services/pending-actions", () => ({
  getAllPendingActionOrders: vi.fn(),
  clearPendingActionsBatch: vi.fn(),
}));

vi.mock("@/lib/services/supabase-flow-logs", () => ({
  logFlowEvent: vi.fn(),
}));

describe("runDrainPendingActions", () => {
  const originalEnabled = config.csPlatform.enabled;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    config.csPlatform.enabled = originalEnabled;
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
