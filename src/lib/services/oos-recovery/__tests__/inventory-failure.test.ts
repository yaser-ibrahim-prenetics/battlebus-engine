import { describe, expect, it } from "vitest";
import type { ShopifyOrderPayload } from "@/inngest/events";
import {
  buildProviderBlockedItems,
  classifyD365InventoryFailure,
  InventoryUnavailableError,
  toInventoryDependencies,
} from "../inventory-failure";

const order = {
  id: 42,
  name: "IM8-42",
  line_items: [
    { id: 11, sku: "IM8-FG-001", quantity: 2, requires_shipping: true, gift_card: false },
    { id: 12, sku: "IM8-FG-001", quantity: 1, requires_shipping: true, gift_card: false },
  ],
} as ShopifyOrderPayload;

describe("typed inventory failures", () => {
  it("preserves duplicate original Shopify lines", () => {
    expect(buildProviderBlockedItems({ order, provider: "gps", warehouse: "jfk01w" })).toEqual([
      {
        provider: "gps",
        warehouse: "JFK01W",
        sku: "IM8-FG-001",
        orderLineId: "11",
        quantityNeeded: 2,
      },
      {
        provider: "gps",
        warehouse: "JFK01W",
        sku: "IM8-FG-001",
        orderLineId: "12",
        quantityNeeded: 1,
      },
    ]);
  });

  it("adds order identity without persisting the provider message", () => {
    const error = new InventoryUnavailableError("gps", "out_of_stock", "raw provider detail");
    expect(
      toInventoryDependencies({
        error,
        order,
        shopifyStore: "IM8HEALTH.MYSHOPIFY.COM",
        warehouse: "JFK01W",
      })
    ).toMatchObject([
      {
        shopifyOrderId: "42",
        shopifyOrderName: "IM8-42",
        shopifyStore: "im8health.myshopify.com",
        safeFailureCategory: "out_of_stock",
        orderLineId: "11",
      },
      { orderLineId: "12" },
    ]);
  });

  it("classifies only recognized D365 inventory failures", () => {
    expect(classifyD365InventoryFailure("Inventory cannot be reserved")).toBe(
      "inventory_insufficient"
    );
    expect(classifyD365InventoryFailure("Released product does not exist")).toBe(
      "item_not_found"
    );
    expect(classifyD365InventoryFailure("OAuth token expired")).toBeNull();
  });
});
