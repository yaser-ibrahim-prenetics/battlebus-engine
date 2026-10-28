import { beforeEach, describe, expect, it, vi } from "vitest";
const { settings, request } = vi.hoisted(() => ({
  settings: {
    features: { enabledShopifyOrderMock: false },
    shopify: { im8: { shopDomain: "alias.myshopify.com" } },
    reconciliation: { expectedShopId: "", shopifyApiVersion: "2026-07" },
  },
  request: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ config: settings }));
vi.mock("@/lib/clients/shopify", () => ({
  shopifyAdminGraphql: request,
  resolveShopifyAdminCredentials: () => ({ shopDomain: "alias.myshopify.com" }),
}));
import { probeShopifyEnvironment } from "../shopify";
beforeEach(() => {
  settings.reconciliation.expectedShopId = "";
  settings.features.enabledShopifyOrderMock = false;
  request.mockResolvedValue({
    data: { shop: { id: "gid://shopify/Shop/123", myshopifyDomain: "canonical.myshopify.com" } },
  });
});
describe("Shopify environment identity", () => {
  it("requires exact hostname identity when no shop ID is pinned", async () => {
    await expect(probeShopifyEnvironment()).rejects.toThrow("identity mismatch");
    request.mockResolvedValue({
      data: { shop: { id: "gid://shopify/Shop/123", myshopifyDomain: "alias.myshopify.com" } },
    });
    expect(await probeShopifyEnvironment()).toMatchObject({ matchedBy: "hostname" });
  });
  it("accepts an authenticated alias only for the explicitly pinned immutable shop", async () => {
    for (const pin of ["123", "gid://shopify/Shop/123"]) {
      settings.reconciliation.expectedShopId = pin;
      expect(await probeShopifyEnvironment()).toMatchObject({
        shopId: "gid://shopify/Shop/123",
        matchedBy: "shop_id",
        canonicalShopDomain: "canonical.myshopify.com",
      });
    }
  });
  it("rejects wrong pinned identities even if the hostname matches", async () => {
    request.mockResolvedValue({
      data: { shop: { id: "gid://shopify/Shop/123", myshopifyDomain: "alias.myshopify.com" } },
    });
    for (const pin of ["456", "malformed"]) {
      settings.reconciliation.expectedShopId = pin;
      await expect(probeShopifyEnvironment()).rejects.toThrow("identity mismatch");
    }
  });
  it("rejects mocks and incomplete provider identities", async () => {
    settings.features.enabledShopifyOrderMock = true;
    await expect(probeShopifyEnvironment()).rejects.toThrow("mocks");
    settings.features.enabledShopifyOrderMock = false;
    request.mockResolvedValue({
      data: { shop: { id: "invalid", myshopifyDomain: "alias.myshopify.com" } },
    });
    await expect(probeShopifyEnvironment()).rejects.toThrow("incomplete");
  });
});
