import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { channelLiftConfigurationProblems, config } from "@/lib/config";

const originalChannelLift = { ...config.channelLift };
const originalShop = config.shopify.im8.shopDomain;

describe("channel-lift startup configuration", () => {
  beforeEach(() => {
    Object.assign(config.channelLift, {
      ...originalChannelLift,
      enabled: true,
      tripleWhaleApiKey: "secret",
      metaAccessToken: "secret",
      tripleWhaleShopId: "im8store.myshopify.com",
      metaDatasetId: "123",
      sourceUrl: "https://im8health.com/",
    });
    Object.assign(config.shopify.im8, { shopDomain: "im8store.myshopify.com" });
  });

  it("accepts only the approved source URL and active shop identity", () => {
    expect(channelLiftConfigurationProblems()).toEqual([]);
    config.channelLift.sourceUrl = "https://evil.invalid/collect";
    expect(channelLiftConfigurationProblems()).toContain(
      "CHANNEL_LIFT_SOURCE_URL is not an approved channel-lift URL"
    );
    config.channelLift.sourceUrl = "https://im8health.com/";
    config.channelLift.tripleWhaleShopId = "other.myshopify.com";
    expect(channelLiftConfigurationProblems()).toContain(
      "CHANNEL_LIFT_TRIPLE_WHALE_SHOP_ID must match the active Shopify store"
    );
  });

  afterAll(() => {
    Object.assign(config.channelLift, originalChannelLift);
    Object.assign(config.shopify.im8, { shopDomain: originalShop });
  });
});
