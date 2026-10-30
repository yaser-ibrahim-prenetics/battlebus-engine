import { describe, expect, it } from "vitest";

import {
  buildMetaPurchaseEvent,
  channelLiftDigest,
  channelLiftRunId,
  countAttributionRows,
  mapAndDeduplicateChannels,
  reconcileAttributionCounts,
  type ShopifyChannelLiftOrder,
} from "@/lib/channel-lift/model";

const order: ShopifyChannelLiftOrder = {
  id: "123",
  processedAt: "2026-10-28T12:00:00Z",
  currency: "USD",
  totalPrice: "12.30",
  test: false,
  cancelledAt: null,
  financialStatus: "paid",
  sourceName: "web",
  email: "PERSON@example.com",
  customerId: "456",
  phone: "+1 (212) 555-0100",
  countryCode: "US",
};

describe("channel-lift model", () => {
  it("preserves deterministic Spock-compatible event and run identities", () => {
    const event = buildMetaPurchaseEvent({
      shop: "im8store.myshopify.com",
      order,
      channel: "Klaviyo",
      sourceUrl: "https://im8health.com/",
      maxEventAgeSeconds: 604_800,
      nowSeconds: Math.floor(Date.parse("2026-10-29T12:00:00Z") / 1000),
    });
    expect(event.event_id).toBe(
      channelLiftDigest(["im8store.myshopify.com", "123", "Purchase_Klaviyo"])
    );
    expect(event.user_data.em).toEqual([
      "542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345",
    ]);
    expect(channelLiftRunId("2026-10-28", "live")).toMatch(/^channel_lift_[a-f0-9]{64}$/);
  });

  it("deduplicates mapped pairs and counts safe exclusions", () => {
    const mapped = mapAndDeduplicateChannels([
      { orderId: "1", channel: "klaviyo", eventDate: "2026-10-28" },
      { orderId: "1", channel: "klaviyo", eventDate: "2026-10-28" },
      { orderId: "2", channel: "Excluded", eventDate: "2026-10-28" },
      { orderId: "3", channel: "other", eventDate: "2026-10-28" },
      { orderId: "4", channel: null, eventDate: "2026-10-28" },
    ]);
    expect(mapped.pairs).toEqual([{ orderId: "1", channel: "Klaviyo" }]);
    expect(mapped.exclusions).toEqual({ excluded_channel: 1, unknown_channel: 2 });
  });

  it("reconciles row, order, and raw order/channel-pair counts", () => {
    const rows = [
      { orderId: "1", channel: "klaviyo", eventDate: "2026-10-28" },
      { orderId: "1", channel: "klaviyo", eventDate: "2026-10-28" },
      { orderId: "1", channel: "other", eventDate: "2026-10-28" },
    ];
    expect(countAttributionRows(rows)).toEqual({ rows: 3, orders: 1, pairs: 2 });
    expect(() => reconcileAttributionCounts(rows, { rows: 3, orders: 1, pairs: 1 })).toThrow(
      "extraction_count_mismatch"
    );
  });

  it.each([
    ["test", { test: true }],
    ["cancelled", { cancelledAt: "2026-10-28T13:00:00Z" }],
    ["unpaid", { financialStatus: "pending" }],
    ["old", { processedAt: "2026-10-01T12:00:00Z" }],
    ["missing identity", { email: null, customerId: null }],
  ])("rejects an ineligible %s order", (_name, change) => {
    expect(() =>
      buildMetaPurchaseEvent({
        shop: "im8store.myshopify.com",
        order: { ...order, ...change },
        channel: "Klaviyo",
        sourceUrl: "https://im8health.com/",
        maxEventAgeSeconds: 604_800,
        nowSeconds: Math.floor(Date.parse("2026-10-29T12:00:00Z") / 1000),
      })
    ).toThrow();
  });

  it("rejects unapproved source URLs", () => {
    expect(() =>
      buildMetaPurchaseEvent({
        shop: "im8store.myshopify.com",
        order,
        channel: "Klaviyo",
        sourceUrl: "https://example.com/",
        maxEventAgeSeconds: 604_800,
        nowSeconds: Math.floor(Date.parse("2026-10-29T12:00:00Z") / 1000),
      })
    ).toThrow("source_url_unapproved");
  });
});
