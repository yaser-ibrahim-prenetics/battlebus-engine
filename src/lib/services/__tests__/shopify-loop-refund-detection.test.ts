import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ShopifyRefundPayload } from "@/inngest/events";
import * as shopify from "@/lib/clients/shopify";
import { shopifyRefundCreatedByLoopReturns } from "../shopify-loop-refund-detection";

vi.mock("@/lib/clients/shopify", () => ({
  getOrderEvents: vi.fn(),
}));

describe("shopifyRefundCreatedByLoopReturns", () => {
  beforeEach(() => {
    vi.mocked(shopify.getOrderEvents).mockReset();
  });

  it("returns false unless there is exactly one refund transaction", async () => {
    vi.mocked(shopify.getOrderEvents).mockResolvedValue({ events: [] });

    const refundMulti: ShopifyRefundPayload = {
      id: 1,
      order_id: 2,
      created_at: "",
      refund_line_items: [],
      transactions: [
        { id: 10, kind: "refund", status: "success", amount: "10" },
        { id: 11, kind: "refund", status: "success", amount: "11" },
      ],
    };
    await expect(shopifyRefundCreatedByLoopReturns("2", refundMulti)).resolves.toBe(false);

    const refundEmpty: ShopifyRefundPayload = {
      id: 1,
      order_id: 2,
      created_at: "",
      refund_line_items: [],
      transactions: [],
    };
    await expect(shopifyRefundCreatedByLoopReturns("2", refundEmpty)).resolves.toBe(false);
    expect(shopify.getOrderEvents).not.toHaveBeenCalled();
  });

  it("returns true when a refund_success event cites the transaction and Loop Returns author", async () => {
    vi.mocked(shopify.getOrderEvents).mockResolvedValue({
      events: [
        {
          id: 1,
          verb: "refund_success",
          path: `/admin/api/2024-01/orders/2/transactions/988553904295.json`,
          author: "5678 (Loop Returns)",
        },
      ],
    });

    const refund: ShopifyRefundPayload = {
      id: 99,
      order_id: 2,
      created_at: "",
      refund_line_items: [],
      transactions: [{ id: 988553904295, kind: "refund", status: "success", amount: "50" }],
    };

    await expect(shopifyRefundCreatedByLoopReturns("2", refund)).resolves.toBe(true);
  });

  it("returns false when order events API fails so Shopify refunds are not wrongly suppressed", async () => {
    vi.mocked(shopify.getOrderEvents).mockRejectedValue(new Error("429"));

    const refund: ShopifyRefundPayload = {
      id: 99,
      order_id: 2,
      created_at: "",
      refund_line_items: [],
      transactions: [{ id: 988553904295, kind: "refund", status: "success", amount: "50" }],
    };

    await expect(shopifyRefundCreatedByLoopReturns("2", refund)).resolves.toBe(false);
  });
});
