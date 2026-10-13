import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOrder, getOrderTransactions } from "@/lib/clients/shopify";
import { loadOrderPaymentAccounting } from "../payment-accounting";
import type { StepTools } from "../types";

vi.mock("@/lib/clients/shopify", () => ({
  getOrder: vi.fn(),
  getOrderTransactions: vi.fn(),
}));

const step: StepTools = {
  run: async <T>(_id: string, handler: () => Promise<T>) => handler(),
  sleep: vi.fn(),
};

describe("loadOrderPaymentAccounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrderTransactions).mockResolvedValue([
      {
        id: 20,
        kind: "capture",
        gateway: "shopify_payments",
        status: "success",
        amount: "50",
        payment_id: "payment-20",
      },
    ]);
  });

  it("refetches issued gift-card codes when the retrying step runs again", async () => {
    const giftCardLine = {
      id: 10,
      gift_card: true,
      price: "50",
      quantity: 1,
    };
    vi.mocked(getOrder)
      .mockResolvedValueOnce({
        line_items: [giftCardLine],
        fulfillments: [],
      } as Awaited<ReturnType<typeof getOrder>>)
      .mockResolvedValueOnce({
        line_items: [giftCardLine],
        fulfillments: [
          {
            receipt: {
              gift_cards: [{ line_item_id: 10, masked_code: "•••• •••• 9876" }],
            },
          },
        ],
      } as Awaited<ReturnType<typeof getOrder>>);

    const input = {
      step,
      shopifyOrderId: "123",
      shopifyOrderName: "IM8-123",
      shopifyStore: "im8-test.myshopify.com",
    };

    await expect(loadOrderPaymentAccounting(input)).rejects.toThrow(
      "does not have an issued masked code yet"
    );
    await expect(loadOrderPaymentAccounting(input)).resolves.toMatchObject({
      paymentReference: "payment-20",
      giftCardCodes: { "10": "9876" },
      giftCardPurchases: [{ giftCardNumber: "9876", price: "50.00", quantity: 1 }],
    });

    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(getOrder).toHaveBeenNthCalledWith(2, "123", "im8-test.myshopify.com");
    expect(getOrderTransactions).toHaveBeenNthCalledWith(2, "123", "im8-test.myshopify.com");
  });
});
