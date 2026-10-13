import type { ShopifyOrderPayload } from "@/inngest/events";

export type AssociatedOrderLink = {
  orderName: string;
  relationship: "associated" | "replacement";
};

const ORDER_TAG_PATTERN = /^(replacement-)?(im8-[a-z0-9-]+)$/i;

/** Spock-compatible associated/replacement order reference encoded in Shopify tags. */
export function getAssociatedOrderLink(
  order: Pick<ShopifyOrderPayload, "tags">
): AssociatedOrderLink | null {
  for (const rawTag of String(order.tags || "").split(",")) {
    const match = rawTag.trim().match(ORDER_TAG_PATTERN);
    if (!match) continue;
    return {
      orderName: match[2].toUpperCase(),
      relationship: match[1] ? "replacement" : "associated",
    };
  }
  return null;
}
