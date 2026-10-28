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
  const inventoryItemId = String(input.inventoryItemId || "").trim();
  if (inventoryItemId) return `shopify-inventory-item:${inventoryItemId}`;
  const variantId = String(input.variantId || "").trim();
  if (variantId) return `shopify-variant:${variantId}`;
  throw new Error("sku, inventoryItemId, or variantId is required for inventory identity");
}
