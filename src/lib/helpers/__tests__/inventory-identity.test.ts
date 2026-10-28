import { describe, expect, it } from "vitest";
import { canonicalInventoryKey } from "../inventory-identity";

describe("canonical inventory identity", () => {
  it("prefers a normalized SKU", () => {
    expect(canonicalInventoryKey({ sku: " im8-1 ", inventoryItemId: "2" })).toBe("sku:IM8-1");
  });

  it("rejects unresolved Shopify inventory identifiers", () => {
    expect(() => canonicalInventoryKey({ inventoryItemId: "123" })).toThrow("resolved SKU");
  });

  it("fails closed without a product identity", () => {
    expect(() => canonicalInventoryKey({})).toThrow("canonical inventory identity");
  });
});
