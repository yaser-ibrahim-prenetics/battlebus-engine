import { createHash } from "node:crypto";

import { config } from "@/lib/config";

export function normalizeCanonicalShopifyStore(
  shopifyStore: string,
  activeStore = config.shopify.im8.shopDomain
): string {
  const normalized = shopifyStore.trim().toLowerCase();
  if (normalized === "im8-battle-bus") return activeStore.trim().toLowerCase();
  return normalized;
}

export function canonicalShopifyOrderId(
  shopifyOrderId: string | number,
  originalShopifyOrderId?: string | number
): string {
  return String(originalShopifyOrderId ?? shopifyOrderId).split("-rerun-")[0];
}

export function toCanonicalShopifyOrderKey({
  shopifyStore,
  shopifyOrderId,
  originalShopifyOrderId,
}: {
  shopifyStore: string;
  shopifyOrderId: string | number;
  originalShopifyOrderId?: string | number;
}): string {
  const identity = JSON.stringify([
    normalizeCanonicalShopifyStore(shopifyStore),
    canonicalShopifyOrderId(shopifyOrderId, originalShopifyOrderId),
  ]);
  return `shopify_order_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}
