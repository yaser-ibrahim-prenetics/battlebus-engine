import {
  canonicalShopifyOrderId,
  toCanonicalShopifyOrderKey,
} from "@/lib/helpers/shopify-order-identity";

const shopifyIdOnlyRerunNames = new Set([
  "shopify/order.paid",
  "shopify/order.created",
  "shopify/order.cancelled",
  "shopify/subscription.renewed",
]);

const canonicalOrderEventNames = new Set([
  "shopify/order.paid",
  "shopify/subscription.renewed",
]);

export function prepareInngestReplayData(
  eventName: string,
  data: Record<string, unknown>,
  sourceRunId: string,
  replayTimestamp = Date.now()
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {
    ...data,
    isRerun: true,
    battleHubReplayOfRunId: sourceRunId,
  };

  if (shopifyIdOnlyRerunNames.has(eventName) && prepared.shopifyOrderId != null) {
    const rawOrderId = String(prepared.shopifyOrderId);
    const canonicalOrderId = canonicalShopifyOrderId(
      rawOrderId,
      prepared.originalShopifyOrderId == null
        ? undefined
        : String(prepared.originalShopifyOrderId)
    );
    prepared.shopifyOrderId = `${canonicalOrderId}-rerun-${replayTimestamp}`;
    if (prepared.originalShopifyOrderId == null) {
      prepared.originalShopifyOrderId = canonicalOrderId;
    }
  }

  if (
    canonicalOrderEventNames.has(eventName) &&
    prepared.shopifyStore != null &&
    prepared.shopifyOrderId != null
  ) {
    prepared.canonicalShopifyOrderKey = toCanonicalShopifyOrderKey({
      shopifyStore: String(prepared.shopifyStore),
      shopifyOrderId: String(prepared.shopifyOrderId),
      originalShopifyOrderId:
        prepared.originalShopifyOrderId == null
          ? undefined
          : String(prepared.originalShopifyOrderId),
    });
  }

  return prepared;
}
