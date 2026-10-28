import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ send: vi.fn(), resolveSku: vi.fn() }));
vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/auth/service-auth", () => ({
  requireServiceAuth: () => ({ ok: true as const }),
}));
vi.mock("@/lib/clients/shopify-inventory", () => ({
  resolveShopifyInventorySku: mocks.resolveSku,
}));

import { POST } from "../route";
import { config } from "@/lib/config";

function request(body: Record<string, unknown>, idempotencyKey?: string) {
  return new NextRequest("http://localhost/api/inventory/sync?from=warehouse&to=shopify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("inventory sync API operation identity", () => {
  const originalEnabled = config.features.enableInventorySync;

  beforeEach(() => {
    vi.resetAllMocks();
    config.features.enableInventorySync = true;
    mocks.resolveSku.mockImplementation(async (body: { sku?: string }) => body.sku || "IM8-1");
    mocks.send.mockResolvedValue({ ids: ["event-1"] });
  });

  afterAll(() => {
    config.features.enableInventorySync = originalEnabled;
  });

  it("requires a caller-provided idempotency key", async () => {
    const response = await POST(request({ sku: "IM8-1", quantity: 2 }));
    expect(response.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("uses the same event ID when a caller retries the same operation", async () => {
    await POST(request({ sku: "IM8-1", quantity: 2 }, "warehouse-adjustment-123"));
    await POST(request({ sku: "IM8-1", quantity: 2 }, "warehouse-adjustment-123"));

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][0].id).toBe(mocks.send.mock.calls[1][0].id);
  });

  it("returns a client error when a Shopify identity has no SKU", async () => {
    mocks.resolveSku.mockRejectedValue(
      new Error("Shopify inventory identity gid://shopify/InventoryItem/404 has no SKU")
    );
    const response = await POST(
      request({ inventoryItemId: "404", quantity: 2 }, "warehouse-adjustment-404")
    );
    expect(response.status).toBe(422);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
