import type { ShopifyOrderPayload } from "../../../inngest/events";
import { isGpsWarehouse } from "../../helpers/warehouse";

export function shouldSendToGps(order: ShopifyOrderPayload, warehouseName?: string): boolean {
  if (warehouseName) return isGpsWarehouse(warehouseName);

  if (!Array.isArray(order.line_items)) {
    console.warn(
      "[Transformers] order.line_items is missing or not an array – treating as no-GPS order. " +
        "This usually means a test payload is incomplete."
    );
    return false;
  }

  return order.line_items.some((item) => item.requires_shipping && !item.gift_card);
}

export function shouldSendToStord(order: ShopifyOrderPayload): boolean {
  void order;
  return false;
}

export function isTestOrder(order: ShopifyOrderPayload): boolean {
  const testTags = ["testing", "load-testing", "test"];
  const tags = (order.tags || "")
    .toLowerCase()
    .split(",")
    .map((tag) => tag.trim());
  return testTags.some((tag) => tags.includes(tag));
}

export function isOrderTaggedWith(
  order: Pick<ShopifyOrderPayload, "tags">,
  tagToCheck: string
): boolean {
  if (!order.tags) return false;
  const normalizedTag = tagToCheck.toLowerCase();
  return order.tags.split(",").some((tag) => tag.trim().toLowerCase().startsWith(normalizedTag));
}
