import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ graphql: vi.fn() }));

vi.mock("@/lib/clients/shopify", () => ({
  shopifyAdminGraphql: mocks.graphql,
}));

import {
  findInventoryItemsBySku,
  resolveShopifyInventorySku,
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

  it("resolves an inventory item to the SKU used for concurrency", async () => {
    mocks.graphql.mockResolvedValueOnce({ data: { inventoryItem: { sku: "IM8-1" } } });

    await expect(resolveShopifyInventorySku({ inventoryItemId: "123" })).resolves.toBe("IM8-1");
    expect(mocks.graphql.mock.calls[0][1]).toEqual({
      id: "gid://shopify/InventoryItem/123",
    });
  });

  it("activates variants and performs an idempotent absolute quantity update", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        data: {
          productVariants: {
            nodes: [
              {
                sku: "IM8-1",
                inventoryItem: {
                  id: "gid://shopify/InventoryItem/1",
                  inventoryLevel: {
                    isActive: true,
                    quantities: [{ name: "available", quantity: 7 }],
                  },
                },
              },
              { sku: "IM8-1", inventoryItem: { id: "gid://shopify/InventoryItem/2" } },
            ],
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
      inventoryItemId: "gid://shopify/InventoryItem/2",
      locationId: "gid://shopify/Location/99",
    });
    expect(activation[1].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);

    const setQuantities = mocks.graphql.mock.calls[2];
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
            changeFromQuantity: 7,
          },
          {
            inventoryItemId: "gid://shopify/InventoryItem/2",
            locationId: "gid://shopify/Location/99",
            quantity: 12,
            changeFromQuantity: 0,
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

  it("re-reads and retries when Shopify reports a stale quantity", async () => {
    const inventoryItem = (quantity: number) => ({
      data: {
        productVariants: {
          nodes: [
            {
              sku: "IM8-1",
              inventoryItem: {
                id: "gid://shopify/InventoryItem/1",
                inventoryLevel: {
                  isActive: true,
                  quantities: [{ name: "available", quantity }],
                },
              },
            },
          ],
        },
      },
    });
    mocks.graphql
      .mockResolvedValueOnce(inventoryItem(5))
      .mockResolvedValueOnce({
        data: {
          inventorySetQuantities: {
            userErrors: [
              {
                code: "CHANGE_FROM_QUANTITY_STALE",
                message: "Available quantity changed",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce(inventoryItem(6))
      .mockResolvedValueOnce({ data: { inventorySetQuantities: { userErrors: [] } } });

    await setSkuInventoryAtLocation({
      sku: "IM8-1",
      locationId: "99",
      quantity: 12,
      referenceDocumentUri: "gid://battle-bus/D365Inventory/U001-IM8-1",
    });

    expect(mocks.graphql.mock.calls[1][1].input.quantities[0].changeFromQuantity).toBe(5);
    expect(mocks.graphql.mock.calls[3][1].input.quantities[0].changeFromQuantity).toBe(6);
    expect(mocks.graphql.mock.calls[1][1].idempotencyKey).not.toBe(
      mocks.graphql.mock.calls[3][1].idempotencyKey
    );
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
