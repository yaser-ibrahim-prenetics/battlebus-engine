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

it("credits tax and freight to segment zero and excludes exhausted balances", () => {
  const financialOrder = {
    ...order,
    currency: "USD",
    total_tax: "10.00",
    shipping_lines: [{ price: "10.00" }],
    line_items: [
      { ...line, id: 1, price: "100.00", quantity: 1, total_discount: "0" },
      { ...line, id: 2, price: "100.00", quantity: 1, total_discount: "0" },
    ],
  };
  const financialPlan = {
    ...stored,
    plan: {
      ...stored.plan,
      segments: stored.plan.segments.map((segment, index) => ({
        ...segment,
        lines: [{ lineItemId: String(index + 1), quantity: 1, physical: true }],
      })),
    },
  };
  const second = {
    ...refund,
    refund_line_items: [
      {
        ...refund.refund_line_items[0],
        line_item_id: 2,
        quantity: 1,
        subtotal: "100.00",
        total_tax: "10.00",
      },
    ],
  };
  expect(
    allocateSegmentRefund(financialPlan, financialOrder as typeof order, second, 12000, []).map(
      (row) => row.amountCents
    )
  ).toEqual([2000, 10000]);
  const amountOnly = { ...refund, refund_line_items: [] };
  const prior = [{ segmentIndex: 0, amountCents: 12000, quantities: { "1": 1 } }];
  expect(
    allocateSegmentRefund(financialPlan, financialOrder as typeof order, amountOnly, 10000, prior)
  ).toEqual([{ segmentIndex: 1, amountCents: 10000, quantities: {} }]);
  expect(() =>
    allocateSegmentRefund(financialPlan, financialOrder as typeof order, amountOnly, 10001, prior)
  ).toThrow("remaining segment balances");
});

it("uses posted shipping discounts, duties and cumulative discount cents for capacity", () => {
  const financialOrder = {
    ...order,
    currency: "USD",
    total_tax: "0",
    tax_lines: [],
    shipping_lines: [{ ...order.shipping_lines[0], price: "10.00", discounted_price: "0.00" }],
    line_items: [{ ...line, id: 1, price: "100.00", quantity: 2, total_discount: "0" }],
  };
  const financialPlan = {
    ...stored,
    plan: {
      ...stored.plan,
      segments: stored.plan.segments.map((segment) => ({
        ...segment,
        lines: [{ lineItemId: "1", quantity: 1, physical: true }],
      })),
    },
  };
  const amountOnly = { ...refund, refund_line_items: [] };
  expect(
    allocateSegmentRefund(financialPlan, financialOrder, amountOnly, 20000, []).map(
      (row) => row.amountCents
    )
  ).toEqual([10000, 10000]);
  const withDuty = {
    ...financialOrder,
    current_total_duties_set: { shop_money: { amount: "10.00", currency_code: "USD" } },
  };
  expect(
    allocateSegmentRefund(financialPlan, withDuty, amountOnly, 21000, []).map(
      (row) => row.amountCents
    )
  ).toEqual([11000, 10000]);
  const discounted = {
    ...financialOrder,
    shipping_lines: [],
    line_items: [{ ...line, id: 1, price: "1.00", quantity: 3, total_discount: "0.01" }],
  };
  const three = {
    ...financialPlan,
    plan: {
      ...financialPlan.plan,
      segments: [0, 1, 2].map((index) => ({ ...financialPlan.plan.segments[0], index })),
    },
  };
  expect(
    allocateSegmentRefund(three, discounted, amountOnly, 299, []).map((row) => row.amountCents)
  ).toEqual([100, 99, 100]);
  expect(() => allocateSegmentRefund(three, discounted, amountOnly, 300, [])).toThrow(
    "remaining segment balances"
  );
});

it("retains purchased gift-card value and uses original posted capacity when available", () => {
  const giftOrder = {
    ...order,
    currency: "USD",
    tax_lines: [],
    total_tax: "0",
    shipping_lines: [],
    line_items: [
      { ...line, id: 1, quantity: 2, price: "10.00", total_discount: "0" },
      {
        ...line,
        id: 2,
        quantity: 1,
        price: "100.00",
        total_discount: "0",
        gift_card: true,
        requires_shipping: false,
      },
    ],
  };
  const giftPlan = {
    ...stored,
    plan: {
      ...stored.plan,
      segments: stored.plan.segments.map((segment) => ({
        ...segment,
        lines: [
          { lineItemId: "1", quantity: 1, physical: true },
          ...(segment.index ? [] : [{ lineItemId: "2", quantity: 1, physical: false }]),
        ],
      })),
    },
  };
  const amountOnly = { ...refund, refund_line_items: [] };
  const accounting = { giftCardApplications: [], purchasedGiftCards: { "2": "1234" } };
  expect(
    allocateSegmentRefund(giftPlan, giftOrder, amountOnly, 12000, [], accounting).map(
      (row) => row.amountCents
    )
  ).toEqual([11000, 1000]);
  expect(() => allocateSegmentRefund(giftPlan, giftOrder, amountOnly, 12000, [])).toThrow(
    "gift-card accounting"
  );
  const posted = {
    ...giftPlan,
    progress: { "0": { postedAmountCents: 11000 }, "1": { postedAmountCents: 1000 } },
  };
  expect(
    allocateSegmentRefund(posted, giftOrder, amountOnly, 12000, []).map((row) => row.amountCents)
  ).toEqual([11000, 1000]);
});
