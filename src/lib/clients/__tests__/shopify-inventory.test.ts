import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ graphql: vi.fn() }));

vi.mock("@/lib/clients/shopify", () => ({
  shopifyAdminGraphql: mocks.graphql,
}));

import {
  findInventoryItemsBySku,
  setSkuInventoryAtLocation,
  shopifyGid,
} from "../shopify-inventory";
import { config } from "@/lib/config";

describe("Shopify inventory client", () => {
  const originalDryRunMode = config.features.dryRunMode;

  beforeEach(() => {
    mocks.graphql.mockReset();
    config.features.dryRunMode = false;
  });

  afterEach(() => {
    config.features.dryRunMode = originalDryRunMode;
  });

  it("normalizes Shopify global IDs", () => {
    expect(shopifyGid("Location", "123")).toBe("gid://shopify/Location/123");
    expect(shopifyGid("InventoryItem", "gid://shopify/InventoryItem/456")).toBe(
      "gid://shopify/InventoryItem/456"
    );
  });

  it("filters the search response to exact SKU matches", async () => {
    mocks.graphql.mockResolvedValueOnce({
      data: {
        productVariants: {
          nodes: [
            { sku: "IM8-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } },
            { sku: "IM8-10", inventoryItem: { id: "gid://shopify/InventoryItem/2" } },
          ],
        },
      },
    });

    await expect(findInventoryItemsBySku("IM8-1")).resolves.toEqual([
      { sku: "IM8-1", inventoryItemId: "gid://shopify/InventoryItem/1" },
    ]);
  });

  it("activates variants and performs an idempotent absolute quantity update", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        data: {
          productVariants: {
            nodes: [
              { sku: "IM8-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } },
              { sku: "IM8-1", inventoryItem: { id: "gid://shopify/InventoryItem/2" } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          inventoryActivate: {
            userErrors: [{ message: "Inventory item is already active at this location" }],
          },
        },
      })
      .mockResolvedValueOnce({ data: { inventoryActivate: { userErrors: [] } } })
      .mockResolvedValueOnce({ data: { inventorySetQuantities: { userErrors: [] } } });

    await expect(
      setSkuInventoryAtLocation({
        sku: "IM8-1",
        locationId: "99",
        quantity: 12.9,
        referenceDocumentUri: "gid://battle-bus/D365Inventory/U001-IM8-1",
      })
    ).resolves.toEqual({
      updated: 2,
      inventoryItemIds: ["gid://shopify/InventoryItem/1", "gid://shopify/InventoryItem/2"],
    });

    const activation = mocks.graphql.mock.calls[1];
    expect(activation[0]).toContain("@idempotent");
    expect(activation[1]).toMatchObject({
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/99",
    });
    expect(activation[1].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);

    const setQuantities = mocks.graphql.mock.calls[3];
    expect(setQuantities[0]).toContain("@idempotent");
    expect(setQuantities[1]).toMatchObject({
      input: {
        name: "available",
        reason: "correction",
        quantities: [
          {
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/99",
            quantity: 12,
            changeFromQuantity: null,
          },
          {
            inventoryItemId: "gid://shopify/InventoryItem/2",
            locationId: "gid://shopify/Location/99",
            quantity: 12,
            changeFromQuantity: null,
          },
        ],
      },
    });
    expect(setQuantities[1].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(setQuantities[2]).toEqual({ apiVersion: "2026-07" });
  });

  it("fails instead of reporting success when a SKU is missing", async () => {
    mocks.graphql.mockResolvedValueOnce({ data: { productVariants: { nodes: [] } } });
    await expect(
      setSkuInventoryAtLocation({
        sku: "MISSING",
        locationId: "99",
        quantity: 1,
        referenceDocumentUri: "gid://battle-bus/D365Inventory/U001-MISSING",
      })
    ).rejects.toThrow("SKU MISSING was not found in Shopify");
  });

  it("does not issue inventory mutations in global dry-run mode", async () => {
    config.features.dryRunMode = true;
    mocks.graphql.mockResolvedValueOnce({
      data: {
        productVariants: {
          nodes: [{ sku: "IM8-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }],
        },
      },
    });

    await expect(
      setSkuInventoryAtLocation({
        sku: "IM8-1",
        locationId: "99",
        quantity: 12,
        referenceDocumentUri: "gid://battle-bus/D365Inventory/U001-IM8-1",
      })
    ).resolves.toEqual({
      updated: 1,
      inventoryItemIds: ["gid://shopify/InventoryItem/1"],
    });

    expect(mocks.graphql).toHaveBeenCalledTimes(1);
    expect(mocks.graphql.mock.calls[0][0]).toContain("query InventoryItemsBySku");
  });
});
