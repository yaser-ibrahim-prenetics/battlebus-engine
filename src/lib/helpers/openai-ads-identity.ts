import { createHash } from "node:crypto";

import {
  canonicalShopifyOrderId,
  normalizeCanonicalShopifyStore,
} from "@/lib/helpers/shopify-order-identity";

export const normalizeOpenAiAdsShopifyStore = normalizeCanonicalShopifyStore;

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
    normalizeCanonicalShopifyStore(shopifyStore),
    canonicalShopifyOrderId(shopifyOrderId, originalShopifyOrderId)
  );
}
