import type { ShopifyRefundPayload } from "@/inngest/events";

const HOUR_MS = 60 * 60 * 1000;

export const UNFULFILLED_REFUND_HOLD_REASON = "unfulfilled_refund_line";

export interface RefundHoldDecision {
  shouldHold: boolean;
  holdUntil: Date | null;
  reason: typeof UNFULFILLED_REFUND_HOLD_REASON | null;
}

function refundTimestamp(refund: ShopifyRefundPayload, now: Date): Date {
  const timestamp = refund.processed_at || refund.created_at;
  if (!timestamp) return now;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

/**
 * Mirrors Spock Store's refunds/create scheduling rule:
 * - amount-only refunds are not held;
 * - any refunded line whose webhook snapshot is not exactly `fulfilled` is held;
 * - the hold is anchored to processed_at, then created_at, then receipt time;
 * - an already elapsed hold is processed immediately.
 *
 * The refund webhook snapshot is deliberately authoritative. This function must
 * not fetch the order's current fulfillment status to override that snapshot.
 */
export function decideRefundHold(
  refund: ShopifyRefundPayload,
  holdHours = 24,
  now = new Date()
): RefundHoldDecision {
  const lineItems = Array.isArray(refund.refund_line_items) ? refund.refund_line_items : [];
  const hasUnfulfilledLine = lineItems.some(
    (item) => item?.line_item?.fulfillment_status !== "fulfilled"
  );

  if (holdHours <= 0 || lineItems.length === 0 || !hasUnfulfilledLine) {
    return { shouldHold: false, holdUntil: null, reason: null };
  }

  const holdUntil = new Date(refundTimestamp(refund, now).getTime() + holdHours * HOUR_MS);
  if (holdUntil.getTime() <= now.getTime()) {
    return { shouldHold: false, holdUntil: null, reason: null };
  }

  return {
    shouldHold: true,
    holdUntil,
    reason: UNFULFILLED_REFUND_HOLD_REASON,
  };
}
