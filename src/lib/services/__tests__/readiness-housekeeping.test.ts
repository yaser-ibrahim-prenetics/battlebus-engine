import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  housekeeping: { enabled: true },
  query: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  config: {
    channelLift: { enabled: false },
    fulfillmentActionHousekeeping: mocks.housekeeping,
    shopify: { im8: { shopDomain: "shop.example", accessToken: "configured" } },
    csPlatform: {
      enabled: true,
      baseUrl: "https://hub.example",
      webhookSecret: "configured",
    },
    features: { dryRunMode: true },
  },
}));
vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => true,
  queryDatabase: mocks.query,
}));

import { checkReadiness } from "@/lib/services/readiness";

describe("fulfillment housekeeping readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.housekeeping.enabled = true;
    process.env.INNGEST_EVENT_KEY = "configured";
    process.env.INNGEST_SIGNING_KEY = "configured";
    delete process.env.K_SERVICE;
  });

  it("fails closed when housekeeping is enabled without its database contract", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: false }] });

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      dependencies: {
        fulfillmentActionHousekeeping: { ready: false, check: "schema-and-privileges" },
      },
    });
  });

  it("accepts the enabled feature only after its schema and privileges are ready", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: true }] });

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: true,
      dependencies: {
        fulfillmentActionHousekeeping: { ready: true, check: "schema-and-privileges" },
      },
    });
  });

  it("requires the tombstone ledger contract while cleanup remains disabled", async () => {
    mocks.housekeeping.enabled = false;
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: false }] });

    const report = await checkReadiness();
    expect(report.ok).toBe(false);
    expect(report.dependencies).not.toHaveProperty("fulfillmentActionHousekeeping");
    expect(report.dependencies).toMatchObject({
      fulfillmentActionLedger: { ready: false, check: "schema-and-privileges" },
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
