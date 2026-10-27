import type { ShopifyOrderPayload } from "@/inngest/events";
import { getOrder } from "@/lib/clients/shopify";
import { validateOrderCompletely } from "@/lib/utils/validation";
import { orderInputHash } from "./planner";

/** Read again before each recovery segment and dispatch; never memoize eligibility. */
export async function loadEligibleRecoveryOrder(
  shop: string,
  orderId: string,
  expectedHash: string
) {
  const order = (await getOrder(orderId, shop)) as unknown as ShopifyOrderPayload;
  if (order.cancelled_at || order.financial_status !== "paid")
    throw new Error("Segment recovery requires an uncancelled, paid order");
  const eligibility = await validateOrderCompletely(order, orderId, order.name, shop);
  if (!eligibility.valid || eligibility.skip)
    throw new Error(`Segment recovery is blocked: ${eligibility.reason || eligibility.status}`);
  if (orderInputHash(order) !== expectedHash)
    throw new Error("Order changed after segment planning");
  return order;
}
