import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryDatabase } from "@/lib/db/database";
import { claimOpenAiAdsConversionForRedelivery } from "../openai-ads-conversions";

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  queryDatabase: vi.fn(),
}));

describe("OpenAI Ads conversion recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atomically resets and claims a conversion for manual redelivery", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          event_id: "shopify_order_1001",
          shopify_order_id: "1001",
          shopify_order_name: "#IM8-1001",
          occurred_at: new Date("2026-10-01T00:00:00.000Z"),
          attempts: 1,
          claim_token: "00000000-0000-4000-8000-000000000001",
        },
      ],
    });

    const claim = await claimOpenAiAdsConversionForRedelivery({
      eventId: "shopify_order_1001",
    });

    const [sql, parameters] = vi.mocked(queryDatabase).mock.calls[0];
    expect(sql).toContain("state IN ('pending', 'dead_letter')");
    expect(sql).toContain("attempts = 1");
    expect(sql).toContain("available_at = now()");
    expect(parameters).toEqual(["shopify_order_1001", expect.any(String), 300]);
    expect(claim).toEqual({
      eventId: "shopify_order_1001",
      shopifyOrderId: "1001",
      shopifyOrderName: "#IM8-1001",
      occurredAt: "2026-10-01T00:00:00.000Z",
      attempts: 1,
      claimToken: "00000000-0000-4000-8000-000000000001",
    });
  });
});
