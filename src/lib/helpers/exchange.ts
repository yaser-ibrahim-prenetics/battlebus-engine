// ============================================================================
// EXCHANGE RATE UTILITIES
// ============================================================================
// Ported from spock-store's exchange.ts
// IM8 uses USD as primary currency but needs to handle multi-currency refunds

import {
  resolveRefundPresentmentCurrency,
  type OrderCurrencyHints,
} from "@/lib/utils/shopify-refund-amount";
import type { ShopifyRefundPayload } from "@/inngest/events";

export interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
  source: "shopify_receipt" | "shopify_transaction" | "fallback";
}

interface RefundReceiptTransaction {
  amount?: string;
  currency?: string;
  receipt?: {
    balance_transaction?: {
      exchange_rate?: number | string;
    } | null;
  } | null;
}

interface RefundReceiptInput {
  transactions?: RefundReceiptTransaction[];
}

/**
 * Prefer the FX rate Stripe/Shopify actually applied to the refund itself
 * (`transactions[i].receipt.balance_transaction.exchange_rate`). This mirrors
 * spock-store's `convertToUsd` path and is more accurate than any pair-based
 * derivation off the order's historical transactions.
 *
 * Returns `null` if no refund transaction carries a usable non-identity rate.
 */
export function extractExchangeRateFromRefundReceipt(
  refund: RefundReceiptInput | null | undefined,
  shopCurrency: string = "USD"
): ExchangeRate | null {
  const target = shopCurrency.toUpperCase();
  const txs = refund?.transactions ?? [];
  for (const tx of txs) {
    const rawRate = tx?.receipt?.balance_transaction?.exchange_rate;
    const rate = typeof rawRate === "string" ? parseFloat(rawRate) : rawRate;
    const from = (tx?.currency || "").toUpperCase();
    if (!rate || !Number.isFinite(rate) || rate <= 0) continue;
    if (!from || from === target) continue;
    return {
      from,
      to: target,
      rate,
      source: "shopify_receipt",
    };
  }
  return null;
}

// Fallback exchange rates (updated periodically)
// Key format: {FROM}_{TO}
const FALLBACK_RATES: Record<string, number> = {
  HKD_USD: 0.128,
  GBP_USD: 1.27,
  EUR_USD: 1.09,
  JPY_USD: 0.0067,
  KRW_USD: 0.00075,
  CAD_USD: 0.74,
  AUD_USD: 0.66,
};

/**
 * Extract exchange rate from Shopify transactions.
 * When a non-USD customer pays, Shopify records the presentment currency
 * and the shop currency amount in the transaction. By comparing two
 * transaction amounts (e.g. a sale and a refund, or two refund transactions
 * in different currencies), we can derive the exchange rate.
 *
 * If only one transaction is present, we can't derive a rate from transactions
 * alone and return null so the caller can fall back.
 */
export function extractExchangeRateFromTransactions(
  transactions: Array<{ amount: string; currency?: string }>,
  shopCurrency: string = "USD"
): ExchangeRate | null {
  if (!transactions || transactions.length < 2) return null;

  // Look for a pair where one is in presentment currency and one in shop currency
  const shopTx = transactions.find((tx) => tx.currency === shopCurrency);
  const presentmentTx = transactions.find((tx) => tx.currency && tx.currency !== shopCurrency);

  if (!shopTx || !presentmentTx) return null;

  const shopAmount = parseFloat(shopTx.amount);
  const presentmentAmount = parseFloat(presentmentTx.amount);

  if (!presentmentAmount || !shopAmount) return null;

  // rate = how many shop currency units per 1 presentment currency unit
  const rate = shopAmount / presentmentAmount;

  return {
    from: presentmentTx.currency!,
    to: shopCurrency,
    rate,
    source: "shopify_transaction",
  };
}

/**
 * Get a fallback exchange rate for a currency pair.
 * Returns null if no fallback rate is available.
 */
export function getFallbackRate(
  fromCurrency: string,
  toCurrency: string = "USD"
): ExchangeRate | null {
  const key = `${fromCurrency.toUpperCase()}_${toCurrency.toUpperCase()}`;
  const rate = FALLBACK_RATES[key];

  if (rate === undefined) return null;

  return {
    from: fromCurrency.toUpperCase(),
    to: toCurrency.toUpperCase(),
    rate,
    source: "fallback",
  };
}

/**
 * Convert refund amount to shop currency (USD).
 * Used when the refund was calculated in presentment currency.
 */
export function convertToShopCurrency(
  amount: number,
  fromCurrency: string,
  exchangeRate?: ExchangeRate | null
): number {
  if (fromCurrency === "USD") return amount;
  if (!exchangeRate) return amount; // fallback: assume 1:1
  return Math.round(amount * exchangeRate.rate * 100) / 100; // round to 2 decimal places
}

export type RefundUsdResolution = {
  refundAmountUsd: number;
  presentmentCurrency: string;
  shopOrderCurrency: string;
  conversionApplied: boolean;
  exchangeRateInfo: {
    from: string;
    to: string;
    rate: number;
    source: ExchangeRate["source"];
  } | null;
};

/**
 * Convert a presentment refund total to USD for D365 posting.
 * Uses presentment currency (not shop `currency`) so GBP refunds on USD shops still convert.
 */
export function resolveRefundAmountUsd(params: {
  refundAmount: number;
  shopifyOrder: OrderCurrencyHints & {
    transactions?: Array<{ amount: string; currency?: string }>;
  };
  refund: ShopifyRefundPayload;
  d365Currency?: string;
}): RefundUsdResolution {
  const d365Currency = (params.d365Currency || "USD").toUpperCase();
  const shopOrderCurrency = (params.shopifyOrder.currency || "USD").toUpperCase();
  const presentmentCurrency = resolveRefundPresentmentCurrency(params.shopifyOrder, params.refund);

  if (presentmentCurrency === d365Currency) {
    return {
      refundAmountUsd: params.refundAmount,
      presentmentCurrency,
      shopOrderCurrency,
      conversionApplied: false,
      exchangeRateInfo: null,
    };
  }

  const orderTransactions = params.shopifyOrder.transactions || params.refund.transactions || [];

  const exchangeRate =
    extractExchangeRateFromRefundReceipt(params.refund, d365Currency) ||
    extractExchangeRateFromTransactions(orderTransactions, d365Currency) ||
    getFallbackRate(presentmentCurrency, d365Currency);

  const refundAmountUsd = convertToShopCurrency(
    params.refundAmount,
    presentmentCurrency,
    exchangeRate
  );

  return {
    refundAmountUsd,
    presentmentCurrency,
    shopOrderCurrency,
    conversionApplied: true,
    exchangeRateInfo: exchangeRate
      ? {
          from: exchangeRate.from,
          to: exchangeRate.to,
          rate: exchangeRate.rate,
          source: exchangeRate.source,
        }
      : null,
  };
}
