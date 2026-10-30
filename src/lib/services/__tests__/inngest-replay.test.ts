import { describe, expect, it } from "vitest";

import { toCanonicalShopifyOrderKey } from "@/lib/helpers/shopify-order-identity";
import { prepareInngestReplayData } from "@/lib/services/inngest-replay";

describe("Inngest replay data", () => {
  it("adds a canonical order key when replaying a historical paid event", () => {
    const prepared = prepareInngestReplayData(
      "shopify/order.paid",
      {
        shopifyOrderId: "123",
        shopifyStore: "active.myshopify.com",
      },
      "source-run",
      456
    );

    expect(prepared).toMatchObject({
      shopifyOrderId: "123-rerun-456",
      originalShopifyOrderId: "123",
      canonicalShopifyOrderKey: toCanonicalShopifyOrderKey({
        shopifyStore: "active.myshopify.com",
        shopifyOrderId: "123",
      }),
      battleHubReplayOfRunId: "source-run",
      isRerun: true,
    });
  });

  it("recomputes a stale supplied key from canonical replay data", () => {
    const prepared = prepareInngestReplayData(
      "shopify/subscription.renewed",
      {
        shopifyOrderId: "123-rerun-old",
        originalShopifyOrderId: "123",
        shopifyStore: "active.myshopify.com",
        canonicalShopifyOrderKey: "stale",
      },
      "source-run",
      456
    );

    expect(prepared.canonicalShopifyOrderKey).toBe(
      toCanonicalShopifyOrderKey({
        shopifyStore: "active.myshopify.com",
        shopifyOrderId: "123",
      })
    );
  });
});
