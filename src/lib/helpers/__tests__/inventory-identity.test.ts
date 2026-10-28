import { describe, expect, it } from "vitest";
import { canonicalInventoryKey } from "../inventory-identity";

describe("canonical inventory identity", () => {
  it("prefers a normalized SKU", () => {
    expect(canonicalInventoryKey({ sku: " im8-1 ", inventoryItemId: "2" })).toBe("sku:IM8-1");
  });

  it("serializes Shopify webhooks by their one-to-one inventory item", () => {
    expect(canonicalInventoryKey({ inventoryItemId: "123" })).toBe(
      "shopify-inventory-item:123"
    );
  });

  it("fails closed without a product identity", () => {
    expect(() => canonicalInventoryKey({})).toThrow("inventory identity");
  });
});
