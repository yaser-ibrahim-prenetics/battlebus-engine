import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../../../../tests/fixtures";
const shopify = vi.hoisted(() => ({
  getOrder: vi.fn(),
  getOrderTransactions: vi.fn(),
  shopifyAdminGraphql: vi.fn(),
}));
vi.mock("@/lib/clients/shopify", () => shopify);
import { loadOrderAccounting } from "../load";

describe("accounting readiness", () => {
  beforeEach(() => vi.resetAllMocks());
  it("refreshes asynchronous issuance receipts on a retry", async () => {
    const order = loadFixture("multiLineOrder");
    order.line_items = [
      { ...order.line_items[0], id: 11, gift_card: true, requires_shipping: false },
    ];
    order.fulfillments = [];
    shopify.getOrder
      .mockResolvedValueOnce({ fulfillments: [] })
      .mockResolvedValueOnce({
        fulfillments: [
          { receipt: { gift_cards: [{ line_item_id: 11, masked_code: "****1234" }] } },
        ],
      });
    shopify.shopifyAdminGraphql.mockResolvedValue({
      data: {
        order: {
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/1",
              kind: "SALE",
              status: "SUCCESS",
              gateway: "shopify_payments",
              paymentId: "payment-1",
            },
          ],
        },
      },
    });
    await expect(loadOrderAccounting(order, "test.myshopify.com")).rejects.toThrow("not ready");
    expect((await loadOrderAccounting(order, "test.myshopify.com")).purchasedGiftCards).toEqual({
      "11": "1234",
    });
    expect(shopify.getOrder).toHaveBeenCalledTimes(2);
    expect(shopify.getOrder).toHaveBeenCalledWith(String(order.id), "test.myshopify.com");
  });
  it("does not post a paid order before a successful payment is available", async () => {
    const order = loadFixture("multiLineOrder");
    order.line_items = [];
    order.financial_status = "paid";
    order.total_price = "100.00";
    shopify.shopifyAdminGraphql.mockResolvedValue({ data: { order: { transactions: [] } } });
    await expect(loadOrderAccounting(order)).rejects.toThrow("no successful payment");
    order.total_price = "0";
    expect((await loadOrderAccounting(order)).paymentId).toBeUndefined();
  });
  it("accepts a fully gift-card funded order without inventing a processor reference", async () => {
    const order = loadFixture("multiLineOrder");
    order.line_items = [];
    order.financial_status = "paid";
    order.total_price = "100.00";
    order.currency = "USD";
    shopify.shopifyAdminGraphql.mockResolvedValue({
      data: {
        order: {
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/1",
              kind: "SALE",
              status: "SUCCESS",
              gateway: "gift_card",
            },
          ],
        },
      },
    });
    shopify.getOrderTransactions.mockResolvedValue([
      {
        id: 1,
        kind: "sale",
        status: "success",
        gateway: "gift_card",
        amount: "100.00",
        currency: "USD",
        receipt: { gift_card_last_characters: "1234" },
      },
    ]);
    const accounting = await loadOrderAccounting(order);
    expect(accounting.paymentId).toBeUndefined();
    expect(accounting.giftCardApplications).toHaveLength(1);
  });
});
