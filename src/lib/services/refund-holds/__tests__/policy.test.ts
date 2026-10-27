import { describe, expect, it } from "vitest";
import type { ShopifyRefundPayload } from "@/inngest/events";
import { refundHoldPolicy } from "../policy";

function refund(statuses: (string | null | undefined)[] = [null], dates = {}) {
  return {
    created_at: "2026-10-20T12:00:00Z",
    ...dates,
    refund_line_items: statuses.map((fulfillment_status) => ({
      line_item: { fulfillment_status },
    })),
  } as ShopifyRefundPayload;
}

describe("refund hold policy", () => {
  it.each([null, undefined, "partial", "unfulfilled"])("holds snapshot status %s", (status) => {
    expect(refundHoldPolicy(refund(["fulfilled", status])).unfulfilledLineCount).toBe(1);
  });
  it.each([[], ["fulfilled"]])(
    "does not hold fulfilled or amount-only refunds: %s",
    (...statuses) => {
      expect(refundHoldPolicy(refund(statuses.flat())).unfulfilledLineCount).toBe(0);
    }
  );
  it("prefers processed_at over created_at and normalizes timezone", () => {
    expect(
      refundHoldPolicy(refund([null], { processed_at: "2026-10-21T12:00:00+08:00" }))
    ).toMatchObject({ raisedAt: "2026-10-21T04:00:00.000Z", timestampSource: "processed_at" });
  });
  it("falls back to a valid created_at", () => {
    expect(refundHoldPolicy(refund([null], { processed_at: "invalid" }))).toMatchObject({
      raisedAt: "2026-10-20T12:00:00.000Z",
      timestampSource: "created_at",
    });
  });
  it.each([undefined, "invalid", "2026-10-21T12:00:00"])(
    "uses database first-seen time for %s",
    (created_at) => {
      expect(refundHoldPolicy(refund([null], { created_at }))).toMatchObject({
        raisedAt: null,
        timestampSource: "first_seen",
      });
    }
  );
  it("holds missing line snapshots and rejects malformed line collections", () => {
    expect(
      refundHoldPolicy({ refund_line_items: [{}] } as ShopifyRefundPayload).unfulfilledLineCount
    ).toBe(1);
    expect(() => refundHoldPolicy({ refund_line_items: {} } as ShopifyRefundPayload)).toThrow(
      "Invalid refund"
    );
  });
});
