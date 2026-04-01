import type { ShopifyRefundPayload } from "@/inngest/events";

/**
 * Sum refunded money from a Shopify Admin refund payload (`refunds/create` webhook).
 * Prefers successful `transactions` of kind `refund`; falls back to `refund_line_items`
 * subtotal + tax when gateways omit or delay transaction rows.
 */
export function computeRefundAmountShopifyPresentment(refund: ShopifyRefundPayload): number {
  const txs = refund.transactions || [];
  const fromTransactions = txs
    .filter((tx) => {
      const kind = (tx.kind || "").toLowerCase();
      const status = (tx.status || "").toLowerCase();
      return kind === "refund" && status === "success";
    })
    .reduce((sum, tx) => sum + parseFloat(tx.amount || "0"), 0);

  if (fromTransactions > 0) {
    return fromTransactions;
  }

  const lineItems = refund.refund_line_items || [];
  return lineItems.reduce((sum, li) => {
    const sub = parseFloat(li.subtotal || "0");
    const tax = parseFloat(li.total_tax || "0");
    return sum + sub + tax;
  }, 0);
}
