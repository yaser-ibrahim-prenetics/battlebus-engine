import { describe, expect, it, vi } from "vitest";

import { readChannelLiftOrders } from "@/lib/clients/channel-lift-shopify";

const node = {
  __typename: "Order",
  id: "gid://shopify/Order/123",
  legacyResourceId: "123",
  processedAt: "2026-10-28T12:00:00Z",
  totalPriceSet: { presentmentMoney: { amount: "12.30", currencyCode: "USD" } },
  test: false,
  cancelledAt: null,
  displayFinancialStatus: "PAID",
  sourceName: "web",
  email: "person@example.com",
  phone: null,
  clientIp: null,
  customAttributes: [],
  customer: {
    legacyResourceId: "456",
    email: "person@example.com",
    phone: null,
    firstName: "Person",
    lastName: "Example",
    defaultAddress: null,
  },
  billingAddress: null,
  shippingAddress: null,
};

describe("Shopify channel-lift reader", () => {
  it("joins only exact requested IDs and maps minimal order data", async () => {
    const request = vi.fn().mockResolvedValue({ data: { nodes: [node] } });
    const result = await readChannelLiftOrders(["123", "123"], {
      request,
      sleep: vi.fn(),
    });
    expect(result.get("123")).toMatchObject({
      id: "123",
      customerId: "456",
      financialStatus: "paid",
      totalPrice: "12.30",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a mismatched Shopify join", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { nodes: [{ ...node, id: "gid://shopify/Order/999" }] },
    });
    await expect(readChannelLiftOrders(["123"], { request, sleep: vi.fn() })).rejects.toThrow(
      "shopify_join_mismatch"
    );
  });
});
