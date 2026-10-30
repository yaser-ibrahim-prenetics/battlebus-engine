import { createHash } from "node:crypto";

import { config } from "@/lib/config";

export function normalizeOpenAiAdsShopifyStore(
  shopifyStore: string,
  activeStore = config.shopify.im8.shopDomain
): string {
  const normalized = shopifyStore.trim().toLowerCase();
  if (normalized === "im8-battle-bus") return activeStore.trim().toLowerCase();
  return normalized;
}

export function canonicalOpenAiAdsShopifyOrderId(
  shopifyOrderId: string | number,
  originalShopifyOrderId?: string | number
): string {
  return String(originalShopifyOrderId ?? shopifyOrderId).split("-rerun-")[0];
}

export function toOpenAiAdsEventId(shopifyStore: string, shopifyOrderId: string | number): string {
  const identity = JSON.stringify([
    shopifyStore.trim().toLowerCase(),
    String(shopifyOrderId),
    "order_created",
  ]);
  return `bb_order_created_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}

export function toCanonicalOpenAiAdsEventId({
  shopifyStore,
  shopifyOrderId,
  originalShopifyOrderId,
}: {
  shopifyStore: string;
  shopifyOrderId: string | number;
  originalShopifyOrderId?: string | number;
}): string {
  return toOpenAiAdsEventId(
    normalizeOpenAiAdsShopifyStore(shopifyStore),
    canonicalOpenAiAdsShopifyOrderId(shopifyOrderId, originalShopifyOrderId)
  );
}
