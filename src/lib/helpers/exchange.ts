// ============================================================================
// EXCHANGE RATE UTILITIES
// ============================================================================
// Ported from spock-store's exchange.ts
// IM8 uses USD as primary currency but needs to handle multi-currency refunds

export interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
  source: 'shopify_transaction' | 'fallback';
}

// Fallback exchange rates (updated periodically)
// Key format: {FROM}_{TO}
const FALLBACK_RATES: Record<string, number> = {
  'HKD_USD': 0.128,
  'GBP_USD': 1.27,
  'EUR_USD': 1.09,
  'JPY_USD': 0.0067,
  'KRW_USD': 0.00075,
  'CAD_USD': 0.74,
  'AUD_USD': 0.66,
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
  shopCurrency: string = 'USD'
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
    source: 'shopify_transaction',
  };
}

/**
 * Get a fallback exchange rate for a currency pair.
 * Returns null if no fallback rate is available.
 */
export function getFallbackRate(
  fromCurrency: string,
  toCurrency: string = 'USD'
): ExchangeRate | null {
  const key = `${fromCurrency.toUpperCase()}_${toCurrency.toUpperCase()}`;
  const rate = FALLBACK_RATES[key];

  if (rate === undefined) return null;

  return {
    from: fromCurrency.toUpperCase(),
    to: toCurrency.toUpperCase(),
    rate,
    source: 'fallback',
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
  if (fromCurrency === 'USD') return amount;
  if (!exchangeRate) return amount; // fallback: assume 1:1
  return Math.round(amount * exchangeRate.rate * 100) / 100; // round to 2 decimal places
}
