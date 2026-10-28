import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../../../tests/fixtures";
import type { ShopifyRefundPayload } from "@/inngest/events";
import type { StoredPlan } from "../../types";
import { allocateCents, allocateSegmentRefund } from "../allocation";
const order = loadFixture("multiLineOrder");
const line = order.line_items[0];
const stored: StoredPlan = {
  plan: {
    version: 1,
    inputHash: "h",
    orderId: String(order.id),
    orderName: order.name,
    segments: [0, 1].map((index) => ({
      index,
      sourceFulfillmentOrderId: String(index),
      locationId: "l",
      warehouse: "GPS Warehouse",
      dataAreaId: index ? "H007" : "U001",
      lines: [{ lineItemId: String(line.id), physical: true, quantity: 2 }],
    })),
  },
  progress: {},
};
const refund: ShopifyRefundPayload = {
  id: 1,
  order_id: order.id,
  created_at: "2026-10-28",
  transactions: [],
  refund_line_items: [
    {
      id: 2,
      line_item_id: line.id,
      quantity: 3,
      line_item: line,
      subtotal: "10.01",
      total_tax: "0",
    },
  ],
};
describe("cross-company refunds", () => {
  it("conserves every cent, including large totals and deterministic rounding", () => {
    expect(allocateCents(101, [1, 1, 1])).toEqual([34, 34, 33]);
    expect(allocateCents(Number.MAX_SAFE_INTEGER, [17, 23, 41]).reduce((a, b) => a + b, 0)).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
  it("allocates line quantities and amounts to their owning legal entity", () => {
    const first = allocateSegmentRefund(stored, order, refund, 1001, []);
    expect(
      first.map((a) => [a.segmentIndex, a.amountCents, a.quantities[String(line.id)]])
    ).toEqual([
      [0, 667, 2],
      [1, 334, 1],
    ]);
    const next = {
      ...refund,
      id: 3,
      refund_line_items: [{ ...refund.refund_line_items[0], quantity: 1, subtotal: "3.34" }],
    };
    expect(allocateSegmentRefund(stored, order, next, 334, first)).toEqual([
      { segmentIndex: 1, amountCents: 334, quantities: { [line.id]: 1 } },
    ]);
    expect(() => allocateSegmentRefund(stored, order, refund, 1001, first)).toThrow("exceeds");
  });
  it("rejects unknown, duplicate and invalid lines before provider writes", () => {
    for (const items of [
      [{ ...refund.refund_line_items[0], line_item_id: -1 }],
      [...refund.refund_line_items, ...refund.refund_line_items],
      [{ ...refund.refund_line_items[0], quantity: -1 }],
    ])
      expect(() =>
        allocateSegmentRefund(stored, order, { ...refund, refund_line_items: items }, 1001, [])
      ).toThrow();
  });
});
