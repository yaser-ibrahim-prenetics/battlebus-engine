import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { prepareChannelLiftReport } from "@/lib/services/channel-lift/report";

const original = { ...config.channelLift };
const originalShop = config.shopify.im8.shopDomain;

const order = {
  id: "123",
  processedAt: "2026-10-28T12:00:00Z",
  currency: "USD",
  totalPrice: "12.30",
  test: false,
  cancelledAt: null,
  financialStatus: "paid",
  sourceName: "web",
  email: "person@example.com",
  customerId: "456",
};

describe("channel-lift report preparation", () => {
  beforeEach(() => {
    Object.assign(config.channelLift, {
      ...original,
      tripleWhaleShopId: "im8store.myshopify.com",
      tripleWhaleApiKey: "secret",
      sourceUrl: "https://im8health.com/",
      maxEventAgeSeconds: 604_800,
    });
    Object.assign(config.shopify.im8, { shopDomain: "im8store.myshopify.com" });
  });

  it("creates privacy-safe evidence and eligible Meta events", async () => {
    const report = await prepareChannelLiftReport("2026-10-28", 1_793_275_200, {
      readAttribution: vi.fn().mockResolvedValue({
        rows: [
          { orderId: "123", channel: "klaviyo", eventDate: "2026-10-28" },
          { orderId: "124", channel: "other", eventDate: "2026-10-28" },
        ],
        counts: { rows: 2, orders: 2, pairs: 2 },
        configHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
      }),
      readOrders: vi.fn().mockResolvedValue(new Map([["123", order]])),
    });
    expect(report.events).toHaveLength(1);
    expect(report.evidence).toMatchObject({
      mappedPairs: 1,
      eligibleEvents: 1,
      exclusionCounts: { unknown_channel: 1 },
    });
    expect(JSON.stringify(report.evidence)).not.toContain("person@example.com");
  });

  it("fails closed when Triple Whale and Shopify shop identities differ", async () => {
    Object.assign(config.shopify.im8, { shopDomain: "different.myshopify.com" });
    await expect(
      prepareChannelLiftReport("2026-10-28", 1_793_275_200, {
        readAttribution: vi.fn(),
        readOrders: vi.fn(),
      })
    ).rejects.toThrow("shop_identity_mismatch");
  });

  it("holds missing and ineligible Shopify orders by safe reason", async () => {
    const report = await prepareChannelLiftReport("2026-10-28", 1_793_275_200, {
      readAttribution: vi.fn().mockResolvedValue({
        rows: [
          { orderId: "123", channel: "klaviyo", eventDate: "2026-10-28" },
          { orderId: "124", channel: "klaviyo", eventDate: "2026-10-28" },
        ],
        counts: { rows: 2, orders: 2, pairs: 2 },
        configHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
      }),
      readOrders: vi
        .fn()
        .mockResolvedValue(new Map([["123", { ...order, financialStatus: "pending" }]])),
    });
    expect(report.events).toHaveLength(0);
    expect(report.evidence.exclusionCounts).toEqual({
      cancelled_refunded_or_unpaid: 1,
      shopify_order_missing_or_mismatched: 1,
    });
  });

  it("binds the privacy-safe snapshot digest to the complete outbound payload", async () => {
    const extraction = {
      rows: [{ orderId: "123", channel: "klaviyo", eventDate: "2026-10-28" }],
      counts: { rows: 1, orders: 1, pairs: 1 },
      configHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
    };
    const first = await prepareChannelLiftReport("2026-10-28", 1_793_275_200, {
      readAttribution: vi.fn().mockResolvedValue(extraction),
      readOrders: vi.fn().mockResolvedValue(new Map([["123", order]])),
    });
    const changed = await prepareChannelLiftReport("2026-10-28", 1_793_275_200, {
      readAttribution: vi.fn().mockResolvedValue(extraction),
      readOrders: vi.fn().mockResolvedValue(
        new Map([
          [
            "123",
            { ...order, email: "changed@example.com", totalPrice: "99.00" },
          ],
        ])
      ),
    });
    expect(changed.events[0].event_id).toBe(first.events[0].event_id);
    expect(changed.evidence.configHash).toBe(first.evidence.configHash);
    expect(changed.evidence.snapshotHash).not.toBe(first.evidence.snapshotHash);
    expect(JSON.stringify(changed.evidence)).not.toContain("changed@example.com");
  });

  afterAll(() => {
    Object.assign(config.channelLift, original);
    Object.assign(config.shopify.im8, { shopDomain: originalShop });
  });
});
