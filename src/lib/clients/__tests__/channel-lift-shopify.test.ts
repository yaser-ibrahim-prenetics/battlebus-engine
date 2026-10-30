import { describe, expect, it, vi } from "vitest";

import { readChannelLiftOrders } from "@/lib/clients/channel-lift-shopify";
import { ShopifyAdminGraphqlError } from "@/lib/clients/shopify";

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

  it("does not retry permanent Shopify authentication failures", async () => {
    const sleep = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValue(new ShopifyAdminGraphqlError("unauthorized", 401, false));
    await expect(readChannelLiftOrders(["123"], { request, sleep })).rejects.toThrow(
      "shopify_rejected"
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries bounded transient Shopify failures", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ShopifyAdminGraphqlError("throttled", 429, true))
      .mockResolvedValueOnce({ data: { nodes: [node] } });
    await expect(readChannelLiftOrders(["123"], { request, sleep })).resolves.toHaveProperty(
      "size",
      1
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
