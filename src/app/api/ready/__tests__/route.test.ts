import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const database = vi.hoisted(() => ({ configured: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: database.configured,
  queryDatabase: database.query,
}));
vi.mock("@/lib/config", () => ({ config: {
  shopify: { im8: { shopDomain: "test.invalid", accessToken: "local-only" } },
  csPlatform: { enabled: true, baseUrl: "https://hub.invalid", webhookSecret: "local-only" },
  features: { dryRunMode: true },
} }));
import { GET } from "../route";
import { GET as detailed } from "../../readiness/route";

beforeEach(() => {
  database.configured.mockReturnValue(true);
  database.query.mockResolvedValue({ rows: [{ ready: 1 }] });
  vi.stubEnv("INNGEST_EVENT_KEY", "local-only");
  vi.stubEnv("INNGEST_SIGNING_KEY", "local-only");
  vi.stubEnv("K_SERVICE", "battle-bus");
  vi.stubEnv("BATTLE_HUB_IAP_ENABLED", "true");
  vi.stubEnv("BATTLE_HUB_CALLER_SERVICE_ACCOUNT", "test@example.invalid");
  vi.stubEnv("BATTLE_BUS_API_KEY", "local-only");
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("reports ready only after the read-only database round trip", async () => {
  const result = await GET();
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true });
  expect(database.query).toHaveBeenCalledWith("SELECT 1 AS ready");
  expect(result.headers.get("Cache-Control")).toBe("no-store");
});
it("fails closed and redacts database failure details", async () => {
  database.query.mockRejectedValue(new Error("private connection details"));
  const result = await GET();
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ ok: false });
});
it("does not connect without database configuration", async () => {
  database.configured.mockReturnValue(false);
  expect((await GET()).status).toBe(503);
  expect(database.query).not.toHaveBeenCalled();
});
it("requires queue and Hub identity configuration", async () => {
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  expect((await GET()).status).toBe(503);
  vi.stubEnv("INNGEST_EVENT_KEY", "local-only");
  vi.stubEnv("BATTLE_HUB_IAP_ENABLED", "false");
  expect((await GET()).status).toBe(503);
});
it("keeps detailed readiness authenticated before querying", async () => {
  expect((await detailed(new NextRequest("https://bus.invalid/api/readiness"))).status).toBe(401);
  expect(database.query).not.toHaveBeenCalled();
});
