export type InventoryIdentityInput = {
  sku?: string;
  inventoryItemId?: string;
  variantId?: string;
};

/** Stable one-product identity used to serialize every inventory write path. */
export function canonicalInventoryKey(input: InventoryIdentityInput): string {
  const sku = String(input.sku || "")
    .trim()
    .toUpperCase();
  if (sku) return `sku:${sku}`;
  throw new Error("A resolved SKU is required for canonical inventory identity");
}
