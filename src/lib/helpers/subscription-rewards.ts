import type { ShopifyOrderPayload } from "@/inngest/events";
import { config } from "@/lib/config";
import { getRefillMapping, getRewardMapping } from "@/lib/transformers/sku";

export const SHOPIFY_SUBSCRIPTION_REWARD_LINE_ITEM_PREFIX = "subscription-reward:";

type RewardOrder = Pick<ShopifyOrderPayload, "id" | "tags"> & {
  line_items: Array<Pick<ShopifyOrderPayload["line_items"][number], "sku" | "quantity">>;
};

export type SubscriptionReward = {
  sku: string;
  quantity: number;
  recurrence: string;
};

export function getSubscriptionRefillQuantity(order: RewardOrder): number {
  const refillSkus = new Set(
    Object.values(getRefillMapping()).map((sku) => String(sku).trim().toUpperCase())
  );
  return order.line_items
    .filter((item) => refillSkus.has(String(item.sku || "").trim().toUpperCase()))
    .reduce((total, item) => total + Math.max(0, Number(item.quantity) || 0), 0);
}

export function getSubscriptionRewards(
  order: RewardOrder,
  enabled = config.features.enableSubscriptionRewards
): SubscriptionReward[] {
  if (!enabled) return [];

  const quantity = getSubscriptionRefillQuantity(order);
  if (quantity <= 0) return [];

  const tags = new Set(
    String(order.tags || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
  );

  return Object.entries(getRewardMapping()).flatMap(([recurrence, sku]) =>
    tags.has(`subscription order ${recurrence}`.toLowerCase())
      ? [{ sku, quantity, recurrence }]
      : []
  );
}

export function subscriptionRewardLineItemId(sku: string): string {
  return `${SHOPIFY_SUBSCRIPTION_REWARD_LINE_ITEM_PREFIX}${String(sku).trim().toUpperCase()}`;
}

export function subscriptionRewardSegmentLineItemId(sku: string, segmentIndex: number): string {
  return `${subscriptionRewardLineItemId(sku)}:segment:${segmentIndex}`;
}

export function isSubscriptionRewardLineItemId(value: string | null | undefined): boolean {
  return String(value || "").startsWith(SHOPIFY_SUBSCRIPTION_REWARD_LINE_ITEM_PREFIX);
}
