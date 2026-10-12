import { describe, expect, it } from "vitest";

import type { ShopifyRefundPayload } from "@/inngest/events";
import { decideRefundHold, UNFULFILLED_REFUND_HOLD_REASON } from "../refund-hold";

function refund(overrides: Partial<ShopifyRefundPayload> = {}): ShopifyRefundPayload {
  return {
    id: 42,
    order_id: 1001,
    created_at: "2026-10-10T00:00:00.000Z",
    refund_line_items: [],
    transactions: [],
    ...overrides,
  };
}

function refundLine(fulfillmentStatus: string | null) {
  return {
    id: 1,
    quantity: 1,
    line_item_id: 11,
    subtotal: "10.00",
    total_tax: "0.00",
    line_item: { fulfillment_status: fulfillmentStatus } as never,
  };
}

describe("decideRefundHold", () => {
  const now = new Date("2026-10-10T01:00:00.000Z");

  it("holds an unfulfilled refund line until 24 hours after processed_at", () => {
    const result = decideRefundHold(
      refund({
        created_at: "2026-10-09T23:00:00.000Z",
        processed_at: "2026-10-10T00:00:00.000Z",
        refund_line_items: [refundLine(null)],
      }),
      24,
      now
    );

    expect(result).toEqual({
      shouldHold: true,
      holdUntil: new Date("2026-10-11T00:00:00.000Z"),
      reason: UNFULFILLED_REFUND_HOLD_REASON,
    });
  });

  it("holds when any refunded line is not exactly fulfilled", () => {
    const result = decideRefundHold(
      refund({
        refund_line_items: [refundLine("fulfilled"), refundLine("partial")],
      }),
      24,
      now
    );

    expect(result.shouldHold).toBe(true);
  });

  it("does not hold when every refunded line is fulfilled", () => {
    const result = decideRefundHold(
      refund({ refund_line_items: [refundLine("fulfilled")] }),
      24,
      now
    );

    expect(result).toEqual({ shouldHold: false, holdUntil: null, reason: null });
  });

  it("does not hold amount-only refunds", () => {
    expect(decideRefundHold(refund(), 24, now).shouldHold).toBe(false);
  });

  it("does not re-hold after the calculated deadline has elapsed", () => {
    const result = decideRefundHold(
      refund({
        created_at: "2026-10-08T00:00:00.000Z",
        refund_line_items: [refundLine(null)],
      }),
      24,
      now
    );

    expect(result.shouldHold).toBe(false);
  });

  it("can be disabled with a zero-hour hold", () => {
    const result = decideRefundHold(refund({ refund_line_items: [refundLine(null)] }), 0, now);

    expect(result.shouldHold).toBe(false);
  });
});
