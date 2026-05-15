import { getOrderEvents } from "@/lib/clients/shopify";
import type { ShopifyRefundPayload } from "@/inngest/events";

/**
 * Match spock-store `refund.isLoopRefundEvent` — refund transaction written by Loop Returns app.
 */
export function isShopifyRefundEventFromLoop(transactionId: number, event: {
  verb?: unknown;
  path?: unknown;
  author?: unknown;
}): boolean {
  const verb = String(event.verb ?? "");
  const path = String(event.path ?? "");
  const author = String(event.author ?? "");
  return (
    verb === "refund_success" &&
    path.includes(`/transactions/${transactionId}`) &&
    author.includes("Loop Returns")
  );
}

/**
 * Spock-store `refund.isLoopRefund`: require exactly one transaction, then inspect order timeline.
 *
 * Multiple transactions returns false (caller processes as a normal Shopify refund).
 */
export async function shopifyRefundCreatedByLoopReturns(
  shopifyOrderNumericId: string,
  refund: ShopifyRefundPayload
): Promise<boolean> {
  const txs = refund.transactions || [];
  if (txs.length !== 1) {
    return false;
  }
  const transactionId = txs[0].id;
  if (typeof transactionId !== "number" || !Number.isFinite(transactionId)) {
    return false;
  }

  const { events } = await getOrderEvents(shopifyOrderNumericId);
  return events.some((e) => isShopifyRefundEventFromLoop(transactionId, e));
}
