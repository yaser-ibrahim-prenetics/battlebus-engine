import { afterEach, describe, expect, it, vi } from "vitest";

import { queryShopifyInventory } from "../shopify-inventory";

vi.mock("@/lib/config", () => ({
  config: {
    features: { dryRunMode: false },
    shopify: {
      im8: {
        shopDomain: "example.myshopify.com",
        apiVersion: "2026-01",
        accessToken: "test-token",
      },
    },
  },
}));

describe("Shopify inventory queries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches a configured numeric location ID to Shopify's location GID", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: {
          productVariants: {
            edges: [
              {
                node: {
                  sku: "SKU-1",
                  inventoryItem: {
                    inventoryLevels: {
                      edges: [
                        {
                          node: {
                            location: { id: "gid://shopify/Location/123" },
                            quantities: [
                              { name: "available", quantity: 17 },
                              { name: "reserved", quantity: 2 },
                            ],
                          },
                        },
                        {
                          node: {
                            location: { id: "gid://shopify/Location/999" },
                            quantities: [{ name: "available", quantity: 50 }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const inventory = await queryShopifyInventory(["SKU-1"], "123");

    expect(inventory.get("SKU-1")).toMatchObject({
      available: 17,
      reserved: 2,
    });
  });
});
