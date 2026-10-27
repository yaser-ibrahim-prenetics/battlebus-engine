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
    shopify.getOrder.mockResolvedValueOnce({ fulfillments: [] }).mockResolvedValueOnce({
      fulfillments: [{ receipt: { gift_cards: [{ line_item_id: 11, masked_code: "****1234" }] } }],
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
  it("ignores a failed gift-card attempt followed by successful card payment", async () => {
    const order = loadFixture("multiLineOrder");
    order.line_items = [];
    order.payment_gateway_names = ["gift_card", "shopify_payments"];
    shopify.shopifyAdminGraphql.mockResolvedValue({
      data: {
        order: {
          transactions: [
            { id: "1", kind: "SALE", status: "FAILURE", gateway: "gift_card" },
            {
              id: "2",
              kind: "SALE",
              status: "SUCCESS",
              gateway: "shopify_payments",
              paymentId: "paid",
            },
          ],
        },
      },
    });
    expect((await loadOrderAccounting(order)).paymentId).toBe("paid");
    expect(shopify.getOrderTransactions).not.toHaveBeenCalled();
  });
  it("requests shop-currency receipts for fully gift-card funded international orders", async () => {
    const order = loadFixture("multiLineOrder");
    order.line_items = [];
    order.financial_status = "paid";
    order.total_price = "100";
    order.currency = "USD";
    order.presentment_currency = "GBP";
    shopify.shopifyAdminGraphql.mockResolvedValue({
      data: {
        order: {
          transactions: [{ id: "1", kind: "SALE", status: "SUCCESS", gateway: "gift_card" }],
        },
      },
    });
    shopify.getOrderTransactions.mockImplementation(async (_id, _shop, options) => [
      {
        id: 1,
        kind: "sale",
        status: "success",
        gateway: "gift_card",
        amount: options?.inShopCurrency ? "100" : "80",
        currency: options?.inShopCurrency ? "USD" : "GBP",
        receipt: { gift_card_last_characters: "1234" },
      },
    ]);
    expect((await loadOrderAccounting(order, "store")).giftCardApplications[0].currency).toBe(
      "USD"
    );
  });
});
