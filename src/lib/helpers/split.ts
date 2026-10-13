// ============================================================================
// FULFILLMENT ORDER SPLITTING
// ============================================================================
// Ported from spock-store's split.ts for IM8
// When an order exceeds a threshold, Shopify fulfillment orders are split
// so multiple shipments can be created from different inventory pools

// IM8 international split threshold (from spock-store config)
const SPLIT_THRESHOLD_INTERNATIONAL = parseFloat(
  process.env.FULFILLMENT_SPLIT_THRESHOLD_INTERNATIONAL || "250"
);

// Domestic (US) orders don't need splitting by default
const SPLIT_THRESHOLD_DOMESTIC = parseFloat(
  process.env.FULFILLMENT_SPLIT_THRESHOLD_DOMESTIC || "0"
);

export interface SplitDecision {
  shouldSplit: boolean;
  reason: string;
  orderTotal: number;
  threshold: number;
}

export interface FulfillmentOrderLineForSplit {
  id: string | number;
  line_item_id: string | number;
  quantity: number;
  fulfillable_quantity?: number;
}

export interface ShopifyLinePrice {
  id: string | number;
  price: string | number;
}

export interface FulfillmentSegmentItem {
  fulfillmentOrderLineItemId: string;
  shopifyLineItemId: string;
  quantity: number;
  unitPrice: number;
}

export interface FulfillmentSegment {
  index: number;
  subtotal: number;
  items: FulfillmentSegmentItem[];
}

/**
 * Partition an open Shopify fulfillment order by value, including splits that
 * divide the quantity of a single line item. This mirrors Spock Store's
 * per-unit segmentation instead of cutting the line-item array at a midpoint.
 */
export function buildFulfillmentSegments(
  fulfillmentLines: FulfillmentOrderLineForSplit[],
  shopifyLines: ShopifyLinePrice[],
  threshold: number
): FulfillmentSegment[] {
  const prices = new Map(
    shopifyLines.map((line) => [String(line.id), Math.max(0, Number(line.price) || 0)])
  );
  const segments: FulfillmentSegment[] = [];
  let items: FulfillmentSegmentItem[] = [];
  let subtotal = 0;

  const flush = () => {
    if (items.length === 0) return;
    segments.push({
      index: segments.length,
      subtotal: Number(subtotal.toFixed(2)),
      items,
    });
    items = [];
    subtotal = 0;
  };

  for (const line of fulfillmentLines) {
    const shopifyLineItemId = String(line.line_item_id);
    const unitPrice = prices.get(shopifyLineItemId);
    if (unitPrice === undefined) {
      throw new Error(
        `Fulfillment line ${line.id} references unknown Shopify line ${shopifyLineItemId}`
      );
    }

    let remaining = Math.max(
      0,
      Math.trunc(Number(line.fulfillable_quantity ?? line.quantity) || 0)
    );
    while (remaining > 0) {
      if (threshold > 0 && items.length > 0 && subtotal + unitPrice > threshold) {
        flush();
      }

      let quantity = remaining;
      if (threshold > 0 && unitPrice > 0) {
        const available = threshold - subtotal;
        quantity = Math.max(1, Math.min(remaining, Math.floor(available / unitPrice)));
      }

      items.push({
        fulfillmentOrderLineItemId: String(line.id),
        shopifyLineItemId,
        quantity,
        unitPrice,
      });
      subtotal += unitPrice * quantity;
      remaining -= quantity;

      if (threshold > 0 && subtotal >= threshold) flush();
    }
  }

  flush();
  return segments;
}

export function toShopifyFulfillmentOrderSplits(segments: FulfillmentSegment[]) {
  return segments.slice(0, -1).map((segment) => ({
    fulfillmentOrderLineItems: segment.items.map((item) => ({
      fulfillmentOrderLineItemId: `gid://shopify/FulfillmentOrderLineItem/${item.fulfillmentOrderLineItemId}`,
      quantity: item.quantity,
    })),
  }));
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
    return { shouldSplit: false, reason: "splitting_disabled", orderTotal, threshold };
  }

  if (orderTotal > threshold) {
    return {
      shouldSplit: true,
      reason: `order_total_${orderTotal}_exceeds_threshold_${threshold}`,
      orderTotal,
      threshold,
    };
  }

  return { shouldSplit: false, reason: "below_threshold", orderTotal, threshold };
}

/**
 * Check if a country is considered domestic (US)
 */
export function isDomesticOrder(countryCode: string): boolean {
  return countryCode === "US";
}
