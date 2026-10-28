import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, shopify, dynamics } = vi.hoisted(() => ({
  query: vi.fn(),
  shopify: vi.fn(),
  dynamics: vi.fn(),
}));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
vi.mock("../shopify", () => ({ shopifyOrderNames: shopify }));
vi.mock("../dynamics", () => ({ dynamicsOrderNames: dynamics }));
vi.mock("@/lib/clients/dynamics/reconciliation", () => ({ probeDynamicsEvidence: vi.fn(async () => ({ schema: "verified" })) }));
vi.mock("@/lib/clients/operations/shopify", () => ({ probeShopifyEnvironment: vi.fn(async () => ({ identity: "verified" })) }));
vi.mock("../details", () => ({ compareOrderDetails: vi.fn(async () => []) }));
import { reconcileD365 } from "../run";
const window = { start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rowCount: 1 });
});
describe("reconciliation run history", () => {
  it("records failure instead of declaring a match from incomplete evidence", async () => {
    shopify.mockResolvedValue(new Set(["IM8-1"]));
    dynamics.mockRejectedValue(new Error("provider unavailable secret"));
    await expect(reconcileD365("salesorder", window, "workflow-1")).rejects.toThrow("inspect run");
    expect(query.mock.calls[2][1].slice(1)).toEqual([
      "failed",
      null,
      "provider_or_persistence_failure",
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret");
  });
  it("persists the full discrepancy result before returning", async () => {
    shopify.mockResolvedValue(new Set(["IM8-1"]));
    dynamics.mockResolvedValue({ U001: new Set(), H007: new Set(["IM8-2"]) });
    const result = await reconcileD365("salesorder", window, "workflow-2");
    expect(result.status).toBe("discrepancies");
    expect(JSON.parse(query.mock.calls[2][1][2])).toMatchObject({
      missingInDynamics: ["IM8-1"],
      missingInShopify: { H007: ["IM8-2"] },
    });
  });
});
