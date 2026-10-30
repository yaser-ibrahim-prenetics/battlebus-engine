import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  query: vi.fn(),
  configurationIssue: vi.fn((): string | null => null),
}));

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: mocks.configured,
  queryDatabase: mocks.query,
}));
vi.mock("@/lib/clients/openai-ads", () => ({
  openAiAdsConfigurationIssue: mocks.configurationIssue,
}));

import {
  enqueueOpenAiAdsConversion,
  openAiAdsRetryDelaySeconds,
  toOpenAiAdsEventId,
} from "../openai-ads-conversions";

describe("durable OpenAI Ads conversions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configured.mockReturnValue(true);
    mocks.configurationIssue.mockReturnValue(null);
  });

  it("derives a stable identity from store, order and conversion type", () => {
    const first = toOpenAiAdsEventId("Store.MyShopify.com", "123");
    expect(first).toBe(toOpenAiAdsEventId("store.myshopify.com", 123));
    expect(first).toMatch(/^bb_order_created_[a-f0-9]{40}$/);
    expect(first).not.toBe(toOpenAiAdsEventId("other.myshopify.com", "123"));
  });

  it("persists one queued minimal conversion", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          event_id: toOpenAiAdsEventId("store.myshopify.com", "123"),
          status: "queued",
          attempts: 0,
          last_error_category: null,
        },
      ],
      rowCount: 1,
    });

    await expect(
      enqueueOpenAiAdsConversion({
        shopifyStore: "store.myshopify.com",
        shopifyOrderId: "123",
        occurredAt: "2026-10-30T00:00:00.000Z",
      })
    ).resolves.toMatchObject({ status: "queued", attempts: 0, reason: null });

    const values = mocks.query.mock.calls[0][1];
    expect(values.slice(1, 4)).toEqual(["store.myshopify.com", "123", "2026-10-30T00:00:00.000Z"]);
    expect(JSON.stringify(values)).not.toContain("customer");
  });

  it("records a safe skip reason without making work deliverable", async () => {
    mocks.configurationIssue.mockReturnValue("integration_disabled");
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          event_id: toOpenAiAdsEventId("store.myshopify.com", "123"),
          status: "skipped",
          attempts: 0,
          last_error_category: "integration_disabled",
        },
      ],
      rowCount: 1,
    });

    await expect(
      enqueueOpenAiAdsConversion({
        shopifyStore: "store.myshopify.com",
        shopifyOrderId: "123",
        occurredAt: "2026-10-30T00:00:00.000Z",
      })
    ).resolves.toMatchObject({ status: "skipped", reason: "integration_disabled" });
    expect(mocks.query.mock.calls[0][1][4]).toBe("skipped");
    expect(mocks.query.mock.calls[0][1][5]).toBe("integration_disabled");
  });

  it("uses the bounded retry schedule", () => {
    expect([1, 2, 3, 4, 5, 6].map(openAiAdsRetryDelaySeconds)).toEqual([
      60, 300, 900, 3600, 14_400, 0,
    ]);
  });

  it("fails closed without PostgreSQL", async () => {
    mocks.configured.mockReturnValue(false);
    await expect(
      enqueueOpenAiAdsConversion({
        shopifyStore: "store.myshopify.com",
        shopifyOrderId: "123",
        occurredAt: "2026-10-30T00:00:00.000Z",
      })
    ).rejects.toThrow("PostgreSQL is required");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
