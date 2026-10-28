import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, shopify, dynamics, details } = vi.hoisted(() => ({
  query: vi.fn(),
  shopify: vi.fn(),
  dynamics: vi.fn(),
  details: vi.fn(),
}));
vi.mock("@/lib/db/database", () => ({
  queryDatabase: query,
  getDatabasePool: async () => ({ connect: async () => ({ query, release() {} }) }),
}));
vi.mock("../shopify", () => ({ shopifyOrderNames: shopify }));
vi.mock("../dynamics", () => ({ dynamicsOrderNames: dynamics }));
vi.mock("@/lib/clients/dynamics/reconciliation", () => ({
  probeDynamicsEvidence: async () => ({ schema: "verified" }),
}));
vi.mock("@/lib/clients/operations/shopify", () => ({
  probeShopifyEnvironment: async () => ({ identity: "verified" }),
}));
vi.mock("../details", () => ({ compareOrderDetails: details }));
import { reconcileD365Durably, failReconciliationWorkflow } from "../durable-run";
const window = { start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" };
function checkpointSteps() {
  const cache = new Map<string, unknown>();
  return {
    run: vi.fn(async (id: string, execute: () => Promise<unknown>) => {
      if (!cache.has(id)) cache.set(id, await execute());
      return cache.get(id);
    }),
  } as unknown as Parameters<typeof reconcileD365Durably>[3];
}
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rowCount: 1 });
  details.mockResolvedValue([]);
});
describe("durable reconciliation run history", () => {
  it("retains successful provider checkpoints across a retry and persists discrepancies", async () => {
    shopify.mockResolvedValue(new Set(Array.from({ length: 6 }, (_, i) => `IM8-${i}`)));
    dynamics.mockResolvedValue({ U001: new Set(), H007: new Set(["IM8-2"]) });
    let fail = true;
    details.mockImplementation(async (names: Set<string>) => {
      if (names.has("IM8-5") && fail) throw new Error("provider unavailable secret");
      return [];
    });
    const step = checkpointSteps();
    await expect(reconcileD365Durably("salesorder", window, "workflow-2", step)).rejects.toThrow(
      "provider unavailable"
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("SET status=$2"))).toBe(false);
    fail = false;
    const result = await reconcileD365Durably("salesorder", window, "workflow-2", step);
    expect(result.status).toBe("discrepancies");
    expect(shopify).toHaveBeenCalledTimes(1);
    expect(dynamics).toHaveBeenCalledTimes(1);
    expect(details).toHaveBeenCalledTimes(7); // first five never repeated
    const completed = query.mock.calls.filter(([sql]) => sql.includes("SET status=$2"));
    expect(completed).toHaveLength(2);
    expect(JSON.parse(completed[0][1][2]).missingInDynamics).toHaveLength(5);
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret");
  });
  it("records retry exhaustion in both histories without leaking provider messages", async () => {
    await failReconciliationWorkflow("workflow-failed");
    expect(query.mock.calls[0][0]).toContain("d365_reconciliation_runs");
    expect(query.mock.calls[0][0]).toContain("reconciliation_attempts");
    expect(query.mock.calls[0][1]).toEqual(["workflow-failed", "workflow_retries_exhausted"]);
  });
});
