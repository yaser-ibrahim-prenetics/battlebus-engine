import { describe, expect, it } from "vitest";

import {
  getGiftCardApplications,
  getGiftCardMaskedCodes,
  getGiftCardPurchases,
  getPurchasePaymentReference,
} from "../payment-accounting";

describe("payment accounting", () => {
  it("uses the non-gift capture payment reference", () => {
    expect(
      getPurchasePaymentReference([
        {
          id: 1,
          kind: "capture",
          gateway: "gift_card",
          status: "success",
          amount: "25",
          payment_id: "gift-payment",
          receipt: { gift_card_last_characters: "1234" },
        },
        {
          id: 2,
          kind: "capture",
          gateway: "shopify_payments",
          status: "success",
          amount: "75",
          payment_id: "fallback-payment",
          receipt: { metadata: { order_id: "pi_order_42" } },
        },
      ])
    ).toBe("pi_order_42");
  });

  it("returns empty for an order with no transactions", () => {
    expect(getPurchasePaymentReference([])).toBe("");
  });

  it("rejects gift-card-only transactions as a purchase reference", () => {
    expect(() =>
      getPurchasePaymentReference([
        {
          id: 1,
          kind: "capture",
          gateway: "gift_card",
          status: "success",
          amount: "25",
          receipt: { gift_card_last_characters: "1234" },
        },
      ])
    ).toThrow("No non-gift Shopify purchase payment reference found");
  });

  it("deduplicates gift-card applications", () => {
    const transaction = {
      id: 1,
      kind: "capture",
      gateway: "gift_card",
      status: "success",
      amount: "25",
      currency: "USD",
      receipt: { gift_card_last_characters: "1234" },
    };
    expect(getGiftCardApplications([transaction, { ...transaction, id: 2 }])).toEqual([
      { giftCardNumber: "1234", amount: "25", currency: "USD" },
    ]);
  });

  it("maps purchased gift cards to masked fulfillment codes", () => {
    const lineItems = [
      { id: 10, gift_card: true, price: "50", quantity: 2 },
    ] as Parameters<typeof getGiftCardMaskedCodes>[1];
    const fulfillments = [
      {
        receipt: {
          gift_cards: [{ line_item_id: 10, masked_code: "•••• •••• 9876" }],
        },
      },
    ] as Parameters<typeof getGiftCardMaskedCodes>[0];

    const codes = getGiftCardMaskedCodes(fulfillments, lineItems);
    expect(codes).toEqual({ "10": "9876" });
    expect(getGiftCardPurchases(lineItems, codes || {})).toEqual([
      { giftCardNumber: "9876", price: "50.00", quantity: 2 },
    ]);
  });

  it("returns null when a purchased gift card has no issued code yet", () => {
    const lineItems = [
      { id: 10, gift_card: true, price: "50", quantity: 1 },
    ] as Parameters<typeof getGiftCardMaskedCodes>[1];
    expect(getGiftCardMaskedCodes([], lineItems)).toBeNull();
  });
});
