// ============================================================================
// FULFILLMENT ORDER SPLITTING
// ============================================================================
// Ported from spock-store's split.ts for IM8
// When an order exceeds a threshold, Shopify fulfillment orders are split
// so multiple shipments can be created from different inventory pools

// IM8 international split threshold (from spock-store config)
const SPLIT_THRESHOLD_INTERNATIONAL = parseFloat(
  process.env.FULFILLMENT_SPLIT_THRESHOLD_INTERNATIONAL || '250'
);

// Domestic (US) orders don't need splitting by default
const SPLIT_THRESHOLD_DOMESTIC = parseFloat(
  process.env.FULFILLMENT_SPLIT_THRESHOLD_DOMESTIC || '0'
);

export interface SplitDecision {
  shouldSplit: boolean;
  reason: string;
  orderTotal: number;
  threshold: number;
}

/**
 * Determine if an order should have its fulfillment orders split
 * Based on order total and shipping destination
 */
export function shouldSplitFulfillmentOrder(
  orderTotal: number,
  countryCode: string,
  isDomestic: boolean = false
): SplitDecision {
  const threshold = isDomestic ? SPLIT_THRESHOLD_DOMESTIC : SPLIT_THRESHOLD_INTERNATIONAL;

  // Threshold of 0 means splitting is disabled
  if (threshold <= 0) {
    return { shouldSplit: false, reason: 'splitting_disabled', orderTotal, threshold };
  }

  if (orderTotal > threshold) {
    return {
      shouldSplit: true,
      reason: `order_total_${orderTotal}_exceeds_threshold_${threshold}`,
      orderTotal,
      threshold,
    };
  }

  return { shouldSplit: false, reason: 'below_threshold', orderTotal, threshold };
}

/**
 * Check if a country is considered domestic (US)
 */
export function isDomesticOrder(countryCode: string): boolean {
  return countryCode === 'US';
}
