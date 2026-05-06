import type { ShopifyRefundPayload } from "@/inngest/events";

/**
 * Sum refunded money from a Shopify Admin refund payload (`refunds/create` webhook).
 * Prefers successful `transactions` of kind `refund`; falls back to `refund_line_items`
 * subtotal + tax when gateways omit or delay transaction rows.
 */
export function computeRefundAmountShopifyPresentment(refund: ShopifyRefundPayload): number {
  const txs = refund.transactions || [];
  const fromSuccessfulTransactions = txs
    .filter((tx) => {
      const kind = (tx.kind || "").toLowerCase();
      const status = (tx.status || "").toLowerCase();
      return kind === "refund" && status === "success";
    })
    .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount || "0")), 0);

  if (fromSuccessfulTransactions > 0) {
    return fromSuccessfulTransactions;
  }

  // Some gateways (for example PayPal) can emit `refunds/create` while the
  // refund transaction is still marked pending. If we only accept "success",
  // we drop valid refunds and never post the negative D365 line.
  const fromPendingTransactions = txs
    .filter((tx) => {
      const kind = (tx.kind || "").toLowerCase();
      const status = (tx.status || "").toLowerCase();
      return kind === "refund" && status === "pending";
    })
    .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount || "0")), 0);

  if (fromPendingTransactions > 0) {
    return fromPendingTransactions;
  }

  const lineItems = refund.refund_line_items || [];
  const fromLineItems = lineItems.reduce((sum, li) => {
    const sub = Math.abs(parseFloat(li.subtotal || "0"));
    const tax = Math.abs(parseFloat(li.total_tax || "0"));
    return sum + sub + tax;
  }, 0);

  if (fromLineItems > 0) {
    return fromLineItems;
  }

  // Last-resort fallback for discrepancy-style refunds where Shopify sends
  // empty refund_line_items and non-final transactions, but includes mirrored
  // +/- order_adjustments rows. We take only positive rows to avoid double-counting.
  const adjustments = refund.order_adjustments || [];
  const fromPositiveAdjustments = adjustments
    .map((adj) => {
      const raw =
        adj?.amount_set?.presentment_money?.amount ??
        adj?.amount_set?.shop_money?.amount ??
        adj?.amount ??
        "0";
      const amount = parseFloat(raw);
      return Number.isFinite(amount) ? amount : 0;
    })
    .filter((amount) => amount > 0)
    .reduce((sum, amount) => sum + amount, 0);

  if (fromPositiveAdjustments > 0) {
    return fromPositiveAdjustments;
  }

  return 0;
}
