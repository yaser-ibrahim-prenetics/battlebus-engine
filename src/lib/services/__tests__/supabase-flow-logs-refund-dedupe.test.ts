import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type StubChainResponse = { data: unknown[] | null; error: { message: string } | null };

const stubState: {
  capturedTable: string | null;
  capturedFilters: Array<{ op: string; args: unknown[] }>;
  response: StubChainResponse;
} = {
  capturedTable: null,
  capturedFilters: [],
  response: { data: [], error: null },
};

function makeQuery() {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((...args: unknown[]) => {
      stubState.capturedFilters.push({ op: "eq", args });
      return chain;
    }),
    in: vi.fn((...args: unknown[]) => {
      stubState.capturedFilters.push({ op: "in", args });
      return chain;
    }),
    filter: vi.fn((...args: unknown[]) => {
      stubState.capturedFilters.push({ op: "filter", args });
      return chain;
    }),
    limit: vi.fn(() => Promise.resolve(stubState.response)),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: vi.fn(() => ({
      from: vi.fn((table: string) => {
        stubState.capturedTable = table;
        return makeQuery();
      }),
    })),
  };
});

describe("hasCompletedRefundFlowLog", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    stubState.capturedTable = null;
    stubState.capturedFilters = [];
    stubState.response = { data: [], error: null };
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
    process.env.FLOW_LOGS_ENABLED = "true";
    delete process.env.FLOW_LOGS_TABLE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns false when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { hasCompletedRefundFlowLog } = await import("../supabase-flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-1")).toBe(false);
  });

  it("returns false for an empty refundId", async () => {
    const { hasCompletedRefundFlowLog } = await import("../supabase-flow-logs");
    expect(await hasCompletedRefundFlowLog("")).toBe(false);
    expect(stubState.capturedTable).toBeNull();
  });

  it("returns true when a completed refund log row is found", async () => {
    stubState.response = {
      data: [{ id: "row-1", step: "refund_line_created", status: "completed", payload: {} }],
      error: null,
    };
    const { hasCompletedRefundFlowLog } = await import("../supabase-flow-logs");
    const found = await hasCompletedRefundFlowLog("refund-42");
    expect(found).toBe(true);
    expect(stubState.capturedTable).toBe("flow_logs");
    const filterCalls = stubState.capturedFilters;
    expect(filterCalls).toContainEqual({ op: "eq", args: ["flow", "refund"] });
    expect(filterCalls).toContainEqual({
      op: "in",
      args: ["step", ["refund_line_created", "done"]],
    });
    expect(filterCalls).toContainEqual({ op: "eq", args: ["status", "completed"] });
    expect(filterCalls).toContainEqual({
      op: "filter",
      args: ["payload->>refundId", "eq", "refund-42"],
    });
  });

  it("returns false when no rows match", async () => {
    stubState.response = { data: [], error: null };
    const { hasCompletedRefundFlowLog } = await import("../supabase-flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-nope")).toBe(false);
  });

  it("returns false when Supabase responds with an error (fail open)", async () => {
    stubState.response = { data: null, error: { message: "boom" } };
    const { hasCompletedRefundFlowLog } = await import("../supabase-flow-logs");
    expect(await hasCompletedRefundFlowLog("refund-err")).toBe(false);
  });
});
