import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveSku: vi.fn() }));
vi.mock("../../client", () => ({
  inngest: { createFunction: (_options: unknown, handler: unknown) => handler },
}));
vi.mock("@/lib/clients/shopify-inventory", () => ({
  resolveShopifyInventorySku: mocks.resolveSku,
}));

import { processShopifyInventoryUpdate } from "../process-shopify-inventory-update";
import { config } from "@/lib/config";

describe("Shopify inventory update resolution", () => {
  const originalEnabled = config.features.enableInventorySync;

  beforeEach(() => {
    vi.resetAllMocks();
    config.features.enableInventorySync = true;
  });

  afterAll(() => {
    config.features.enableInventorySync = originalEnabled;
  });

  it("resolves the canonical SKU in a retryable step before dispatching mesh events", async () => {
    mocks.resolveSku.mockResolvedValue("IM8-1");
    const sendEvent = vi.fn(async () => ({}));
    const step = {
      run: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()),
      sendEvent,
    };
    const run = processShopifyInventoryUpdate as unknown as (input: {
      event: Record<string, unknown>;
      step: typeof step;
    }) => Promise<Record<string, unknown>>;

    await run({
      event: {
        data: {
          sourceOperationId: "webhook-123",
          inventoryItemId: "456",
          locationId: "789",
          available: 12,
          updatedAt: "2026-10-28T00:00:00.000Z",
          shopifyStore: "example.myshopify.com",
        },
      },
      step,
    });

    expect(mocks.resolveSku).toHaveBeenCalledWith(
      { inventoryItemId: "456" },
      "example.myshopify.com"
    );
    expect(sendEvent).toHaveBeenCalledTimes(2);
    expect(sendEvent.mock.calls.map((call) => call[1].id)).toEqual([
      "inventory-sync-shopify-dynamics-webhook-123",
      "inventory-sync-shopify-gps-webhook-123",
    ]);
    for (const [, event] of sendEvent.mock.calls) {
      expect(event.data.payload).toMatchObject({
        inventoryKey: "sku:IM8-1",
        sku: "IM8-1",
        inventoryItemId: "456",
        locationId: "789",
        quantity: 12,
      });
    }
  });
});
