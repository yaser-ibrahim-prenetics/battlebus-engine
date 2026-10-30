import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const database = vi.hoisted(() => ({ configured: vi.fn(), query: vi.fn() }));
const appConfig = vi.hoisted(() => ({
  shopify: { im8: { shopDomain: "test.invalid", accessToken: "local-only" } },
  csPlatform: { enabled: true, baseUrl: "https://hub.invalid", webhookSecret: "local-only" },
  features: { dryRunMode: true, enableDynamicsSync: false, enableGpsSync: false },
  reconciliation: { directD365Enabled: false },
  dynamics: { baseUrl: "", tenantId: "", clientId: "", clientSecret: "" },
  channelLift: { enabled: false },
}));
vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: database.configured,
  queryDatabase: database.query,
}));
vi.mock("@/lib/config", () => ({ config: appConfig }));
import { GET } from "../route";
import { GET as detailed } from "../../readiness/route";

beforeEach(() => {
  database.configured.mockReturnValue(true);
  database.query.mockResolvedValue({ rows: [{ ready: true }] });
  appConfig.channelLift.enabled = false;
  vi.stubEnv("INNGEST_EVENT_KEY", "local-only");
  vi.stubEnv("INNGEST_SIGNING_KEY", "local-only");
  vi.stubEnv("K_SERVICE", "battle-bus");
  vi.stubEnv("BATTLE_HUB_IAP_ENABLED", "true");
  vi.stubEnv("BATTLE_HUB_CALLER_SERVICE_ACCOUNT", "test@example.invalid");
  vi.stubEnv("BATTLE_BUS_API_KEY", "local-only");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

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
it("fails closed when enabled channel-lift schema is unavailable", async () => {
  appConfig.channelLift.enabled = true;
  database.query
    .mockResolvedValueOnce({ rows: [{ ready: true }] })
    .mockResolvedValueOnce({ rows: [{ ready: false }] })
    .mockResolvedValueOnce({ rows: [{ ready: true }] });
  expect((await GET()).status).toBe(503);
  expect(database.query).toHaveBeenCalledTimes(3);
  const schemaQuery = database.query.mock.calls[1][0] as string;
  expect(schemaQuery).toContain("pg_trigger");
  expect(schemaQuery).toContain("relrowsecurity");
  expect(schemaQuery).toContain("pg_policies");
  expect(schemaQuery).toContain("has_any_column_privilege");
});
it("keeps detailed readiness authenticated before querying", async () => {
  expect((await detailed(new NextRequest("https://bus.invalid/api/readiness"))).status).toBe(401);
  expect(database.query).not.toHaveBeenCalled();
});

it("keeps configured Inngest and Hub dependencies unverified for cutover probes", async () => {
  const { getReadinessReport } = await import("@/lib/services/readiness");
  const result = await getReadinessReport();
  for (const name of ["inngest", "battleHub"]) {
    expect(result.dependencies.find((item) => item.name === name)).toMatchObject({
      required: true,
      status: "ready",
      check: "configuration",
    });
  }
  expect(result.dependencies.find((item) => item.name === "fulfillmentActionLedger")).toMatchObject(
    {
      required: true,
      status: "ready",
      check: "schema-and-privileges",
    }
  );
});
