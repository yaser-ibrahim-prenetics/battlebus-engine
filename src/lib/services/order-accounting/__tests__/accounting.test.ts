import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../../tests/fixtures";
import type { ShopifyTransaction } from "@/inngest/events";
import {
  resolvePaymentReference,
  resolveGiftCardApplications,
  resolvePurchasedGiftCards,
} from "../policy";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  toOrderLineRecords,
} from "@/lib/transformers/order";
const base = {
  id: "1",
  kind: "SALE",
  status: "SUCCESS",
  gateway: "shopify_payments",
  order: { id: "gid://shopify/Order/123" },
};

describe("Shopify payment and gift-card accounting", () => {
  it("uses the successful processor reference, ignoring failed and gift-card payments", () => {
    expect(
      resolvePaymentReference([
        { ...base, paymentId: "failed", status: "FAILURE" },
        { ...base, paymentId: "gift", gateway: "gift_card" },
        { ...base, paymentId: "pi_actual" },
      ])
    ).toBe("pi_actual");
    expect(resolvePaymentReference([base])).toBe("123");
    expect(resolvePaymentReference([{ ...base, gateway: "gift_card" }])).toBeUndefined();
  });
  it("keeps distinct gift-card captures and ignores retries of the same transaction", () => {
    const tx = {
      id: 1,
      kind: "capture",
      status: "success",
      gateway: "gift_card",
      amount: "25.00",
      currency: "USD",
      receipt: { gift_card_last_characters: "1234" },
    } as ShopifyTransaction;
    expect(
      resolveGiftCardApplications([tx, tx, { ...tx, id: 2 }, { ...tx, id: 3, status: "failure" }])
    ).toEqual(Array(2).fill({ giftCardNumber: "1234", amount: "25.00", currency: "USD" }));
  });
  it("puts receipt identifiers on D365 headers and purchase lines, never on GPS physical lines", () => {
    const order = loadFixture("multiLineOrder");
    const gift = order.line_items.find((line: { gift_card: boolean }) => line.gift_card)!;
    order.fulfillments = [
      { receipt: { gift_cards: [{ line_item_id: gift.id, masked_code: "••••-5678" }] } },
    ];
    const accounting = {
      paymentId: "pi_actual",
      giftCardApplications: [{ giftCardNumber: "1234", amount: "25.00", currency: "USD" }],
      purchasedGiftCards: resolvePurchasedGiftCards(order),
    };
    const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse", "U001", accounting);
    expect(header.paymentId).toBe("pi_actual");
    expect(header.comment).toContain("Gift Card: 1234 - 25.00 USD");
    expect(header.comment).toContain("Gift Card Purchase: 5678");
    const lines = toD365SalesOrderLines(order, "SO-1", "GPS Warehouse", true, "U001", accounting);
    expect(lines.find((line) => line.giftCardNumber === "5678")?.quantity).toBe(gift.quantity);
    expect(
      toOrderLineRecords(order, "SO-1", "GPS Warehouse", "U001", accounting).some(
        (line) => line.shopifyLineItemId === String(gift.id)
      )
    ).toBe(true);
    expect(
      toGpsOutboundOrder(order, "SO-1", "GPS Warehouse").productList.some(
        (line) => line.sku === gift.sku
      )
    ).toBe(false);
  });
  it("waits for issuance receipts before creating financial records", () => {
    const order = loadFixture("multiLineOrder");
    order.fulfillments = [];
    expect(() => resolvePurchasedGiftCards(order)).toThrow("receipt is not ready");
  });
});
