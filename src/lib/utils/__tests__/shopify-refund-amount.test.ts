import { describe, it, expect } from "vitest";
import { computeRefundAmountShopifyPresentment } from "../shopify-refund-amount";
import type { ShopifyRefundPayload } from "@/inngest/events";

function baseRefund(overrides: Partial<ShopifyRefundPayload> = {}): ShopifyRefundPayload {
  return {
    id: 1,
    order_id: 2,
    created_at: "",
    refund_line_items: [],
    transactions: [],
    ...overrides,
  };
}

describe("computeRefundAmountShopifyPresentment", () => {
  it("sums successful refund transactions (case-insensitive status)", () => {
    const refund = baseRefund({
      transactions: [
        { id: 1, kind: "refund", gateway: "bogus", status: "SUCCESS", amount: "10.00" },
        { id: 2, kind: "refund", gateway: "bogus", status: "success", amount: "5.50" },
        { id: 3, kind: "refund", gateway: "bogus", status: "pending", amount: "99" },
      ],
    });
    expect(computeRefundAmountShopifyPresentment(refund)).toBe(15.5);
  });

  it("falls back to refund_line_items subtotal + tax when transactions yield 0", () => {
    const refund = baseRefund({
      transactions: [],
      refund_line_items: [
        {
          id: 1,
          quantity: 1,
          line_item_id: 10,
          line_item: {} as any,
          subtotal: "100.00",
          total_tax: "8.00",
        },
      ],
    });
    expect(computeRefundAmountShopifyPresentment(refund)).toBe(108);
  });

  it("uses pending refund transactions when success rows are unavailable", () => {
    const refund = baseRefund({
      transactions: [
        { id: 1, kind: "refund", gateway: "paypal", status: "pending", amount: "245.70" },
      ],
      refund_line_items: [],
    });
    expect(computeRefundAmountShopifyPresentment(refund)).toBe(245.7);
  });

  it("falls back to positive order_adjustments when other refund sources are empty", () => {
    const refund = baseRefund({
      transactions: [],
      refund_line_items: [],
      order_adjustments: [
        {
          amount: "-287.84",
          amount_set: {
            presentment_money: { amount: "-245.70", currency_code: "EUR" },
            shop_money: { amount: "-287.84", currency_code: "USD" },
          },
        },
        {
          amount: "287.84",
          amount_set: {
            presentment_money: { amount: "245.70", currency_code: "EUR" },
            shop_money: { amount: "287.84", currency_code: "USD" },
          },
        },
      ] as any,
    });
    expect(computeRefundAmountShopifyPresentment(refund)).toBe(245.7);
  });
});
