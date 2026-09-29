import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({
  configured: true,
  rows: [] as unknown[],
  error: null as Error | null,
  query: vi.fn(),
}));

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => databaseState.configured,
  quoteIdentifier: (identifier: string) => `"${identifier}"`,
  queryDatabase: databaseState.query,
}));

describe("hasCompletedRefundFlowLog", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    databaseState.configured = true;
    databaseState.rows = [];
    databaseState.error = null;
    databaseState.query.mockReset();
    databaseState.query.mockImplementation(async () => {
      if (databaseState.error) throw databaseState.error;
      return { rows: databaseState.rows, rowCount: databaseState.rows.length };
    });
    process.env.FLOW_LOGS_ENABLED = "true";
    delete process.env.FLOW_LOGS_TABLE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns false when PostgreSQL is not configured", async () => {
    databaseState.configured = false;
    const { hasCompletedRefundFlowLog } = await import("../flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-1")).toBe(false);
  });

  it("returns false for an empty refundId", async () => {
    const { hasCompletedRefundFlowLog } = await import("../flow-logs");
    expect(await hasCompletedRefundFlowLog("")).toBe(false);
    expect(databaseState.query).not.toHaveBeenCalled();
  });

  it("returns true when a completed refund log row is found", async () => {
    databaseState.rows = [{ exists: 1 }];
    const { hasCompletedRefundFlowLog } = await import("../flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-42")).toBe(true);
    expect(databaseState.query).toHaveBeenCalledOnce();
    expect(databaseState.query.mock.calls[0][0]).toContain("payload->>'refundId' = $2");
    expect(databaseState.query.mock.calls[0][1]).toEqual([
      ["refund_line_created", "done"],
      "refund-42",
    ]);
  });

  it("returns false when no rows match", async () => {
    const { hasCompletedRefundFlowLog } = await import("../flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-nope")).toBe(false);
  });

  it("returns false when PostgreSQL responds with an error (fail open)", async () => {
    databaseState.error = new Error("boom");
    const { hasCompletedRefundFlowLog } = await import("../flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-err")).toBe(false);
  });
});
