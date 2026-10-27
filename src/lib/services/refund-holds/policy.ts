import type { ShopifyRefundPayload } from "@/inngest/events";

/** Match Spock's refund snapshot, not the order's potentially newer fulfillment state. */
export function refundHoldPolicy(refund: ShopifyRefundPayload) {
  if (refund.refund_line_items != null && !Array.isArray(refund.refund_line_items)) {
    throw new Error("Invalid refund line items");
  }
  const unfulfilledLineCount = (refund.refund_line_items ?? []).filter(
    (line) => line?.line_item?.fulfillment_status !== "fulfilled"
  ).length;

  for (const field of ["processed_at", "created_at"] as const) {
    const value = refund[field];
    // Require an explicit timezone so workers cannot interpret the same date differently.
    if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) continue;
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) {
      return {
        unfulfilledLineCount,
        raisedAt: new Date(millis).toISOString(),
        timestampSource: field,
      };
    }
  }
  // The database chooses and persists first-seen time, including after worker crashes.
  return { unfulfilledLineCount, raisedAt: null, timestampSource: "first_seen" as const };
}
