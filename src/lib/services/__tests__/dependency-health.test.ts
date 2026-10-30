import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readiness: vi.fn(), shopify: vi.fn() }));
vi.mock("../readiness", () => ({ getReadinessReport: mocks.readiness }));
vi.mock("@/lib/clients/dependency-probes", () => ({
  dependencyProbes: { shopify: mocks.shopify },
}));
vi.mock("@/lib/config", () => ({
  config: {
    features: { dryRunMode: false, enableStordSync: false },
    openAiAds: { enabled: false },
    loop: { enabled: false },
  },
}));
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it("does not call configured credentials healthy without an authenticated probe", async () => {
  mocks.readiness.mockResolvedValue({
    ok: true,
    dependencies: [{ name: "inngest", required: true, status: "ready", check: "configuration" }],
  });
  const { getDependencyHealth } = await import("../dependency-health");
  const result = await getDependencyHealth();
  expect(result.ok).toBe(false);
  expect(result.dependencies[0].status).toBe("unverified");
});
it("sanitizes denied provider access and shares probes between pollers", async () => {
  mocks.readiness.mockResolvedValue({
    ok: true,
    dependencies: [{ name: "shopify", required: true, status: "ready", check: "configuration" }],
  });
  mocks.shopify.mockRejectedValue(new Error("secret provider response"));
  const { getDependencyHealth } = await import("../dependency-health");
  const [one, two] = await Promise.all([getDependencyHealth(), getDependencyHealth()]);
  expect(one).toEqual(two);
  expect(one.ok).toBe(false);
  expect(JSON.stringify(one)).not.toContain("secret");
  expect(mocks.shopify).toHaveBeenCalledTimes(1);
});
