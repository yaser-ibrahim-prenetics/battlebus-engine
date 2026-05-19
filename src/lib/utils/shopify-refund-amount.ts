import type { ShopifyRefundPayload } from "@/inngest/events";

export type RefundAmountSource =
  | "success_transactions"
  | "pending_transactions"
  | "refund_line_items"
  | "order_adjustments"
  | "zero";

export type RefundAmountBreakdown = {
  amount: number;
  source: RefundAmountSource;
  /** Currencies seen on refund-kind transactions (for audit). */
  transactionCurrencies: string[];
  /** Presentment currency from order_adjustments when that path is used. */
  adjustmentPresentmentCurrency: string | null;
};

export type OrderCurrencyHints = {
  currency?: string;
  presentment_currency?: string;
};

/**
 * Currency the refund amount is denominated in (presentment), not necessarily shop `currency`.
 * IM8 shop currency is often USD while UK customers pay/refund in GBP.
 */
export function resolveRefundPresentmentCurrency(
  order: OrderCurrencyHints,
  refund: ShopifyRefundPayload
): string {
  const refundTxs = (refund.transactions || []).filter(
    (tx) => (tx.kind || "").toLowerCase() === "refund"
  );

  for (const tx of refundTxs) {
    const c = (tx.currency || "").trim().toUpperCase();
    if (c && c !== "USD") return c;
  }
  for (const tx of refundTxs) {
    const c = (tx.currency || "").trim().toUpperCase();
    if (c) return c;
  }

  const orderPresentment = (order.presentment_currency || "").trim().toUpperCase();
  if (orderPresentment) return orderPresentment;

  return (order.currency || "USD").toUpperCase();
}

/**
 * Sum refunded money from a Shopify Admin refund payload (`refunds/create` webhook).
 * Prefers successful `transactions` of kind `refund`; falls back to `refund_line_items`
 * subtotal + tax when gateways omit or delay transaction rows.
 */
export function analyzeRefundAmount(refund: ShopifyRefundPayload): RefundAmountBreakdown {
  const txs = refund.transactions || [];
  const refundTxCurrencies = txs
    .filter((tx) => (tx.kind || "").toLowerCase() === "refund")
    .map((tx) => (tx.currency || "unknown").toUpperCase());

  const fromSuccessfulTransactions = txs
    .filter((tx) => {
      const kind = (tx.kind || "").toLowerCase();
      const status = (tx.status || "").toLowerCase();
      return kind === "refund" && status === "success";
    })
    .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount || "0")), 0);

  if (fromSuccessfulTransactions > 0) {
    return {
      amount: fromSuccessfulTransactions,
      source: "success_transactions",
      transactionCurrencies: refundTxCurrencies,
      adjustmentPresentmentCurrency: null,
    };
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
    return {
      amount: fromPendingTransactions,
      source: "pending_transactions",
      transactionCurrencies: refundTxCurrencies,
      adjustmentPresentmentCurrency: null,
    };
  }

  const lineItems = refund.refund_line_items || [];
  const fromLineItems = lineItems.reduce((sum, li) => {
    const sub = Math.abs(parseFloat(li.subtotal || "0"));
    const tax = Math.abs(parseFloat(li.total_tax || "0"));
    return sum + sub + tax;
  }, 0);

  if (fromLineItems > 0) {
    return {
      amount: fromLineItems,
      source: "refund_line_items",
      transactionCurrencies: refundTxCurrencies,
      adjustmentPresentmentCurrency: null,
    };
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

  const adjustmentPresentmentCurrency =
    adjustments.find((adj) => adj?.amount_set?.presentment_money?.currency_code)
      ?.amount_set?.presentment_money?.currency_code ?? null;

  if (fromPositiveAdjustments > 0) {
    return {
      amount: fromPositiveAdjustments,
      source: "order_adjustments",
      transactionCurrencies: refundTxCurrencies,
      adjustmentPresentmentCurrency,
    };
  }

  return {
    amount: 0,
    source: "zero",
    transactionCurrencies: refundTxCurrencies,
    adjustmentPresentmentCurrency: null,
  };
}

export function computeRefundAmountShopifyPresentment(refund: ShopifyRefundPayload): number {
  return analyzeRefundAmount(refund).amount;
}
