import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
const mocked = vi.hoisted(() => ({ parity: vi.fn(), health: vi.fn(), dependencies: vi.fn() }));
vi.mock("@/lib/services/cutover/evidence", () => ({ getCutoverReport: mocked.parity }));
vi.mock("@/lib/services/workflow-health", () => ({ getWorkflowHealth: mocked.health }));
vi.mock("@/lib/services/dependency-health", () => ({ getDependencyHealth: mocked.dependencies }));
beforeEach(() => {
  vi.stubEnv("BATTLE_BUS_API_KEY", "test-secret");
  vi.stubEnv("BATTLE_BUS_VERSION", "a".repeat(40));
  mocked.parity.mockResolvedValue({ ready: true });
  mocked.health.mockResolvedValue({ ok: true });
  mocked.dependencies.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const request = (query = "", authenticated = true) =>
  new NextRequest("https://bus.test/api/admin/cutover" + query, {
    headers: authenticated ? { authorization: "Bearer test-secret" } : {},
  });
it("authenticates before probing providers or reading evidence", async () => {
  expect((await GET(request("", false))).status).toBe(401);
  expect(mocked.parity).not.toHaveBeenCalled();
  expect(mocked.dependencies).not.toHaveBeenCalled();
});
it("requires immutable revisions and rejects branch names", async () => {
  expect((await GET(request("?revision=develop"))).status).toBe(400);
});
it("does not certify an undeployed candidate using current dependency health", async () => {
  const result = await (await GET(request("?revision=" + "b".repeat(40)))).json();
  expect(result.ready).toBe(false);
  expect(result.candidateDeployed).toBe(false);
});
it("combines evidence and dependency gates without hiding a failure", async () => {
  mocked.parity.mockResolvedValue({ ready: false });
  expect((await (await GET(request())).json()).ready).toBe(false);
});
it("sanitizes unavailable evidence without returning provider exceptions", async () => {
  mocked.health.mockRejectedValue(new Error("secret payload"));
  const result = await GET(request());
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ ready: false, error: "cutover_evidence_unavailable" });
});
