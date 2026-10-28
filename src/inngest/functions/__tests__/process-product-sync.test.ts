import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ productDeleted: vi.fn() }));
vi.mock("../../client", () => ({
  inngest: { createFunction: (_options: unknown, handler: unknown) => handler },
}));
vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => false,
  queryDatabase: vi.fn(),
}));
vi.mock("@/lib/clients/dynamics", () => ({}));
vi.mock("@/lib/clients/gps", () => ({}));
vi.mock("@/lib/clients/slack", () => ({}));
vi.mock("@/lib/clients/shopify", () => ({}));
vi.mock("@/lib/clients/cs-platform", () => ({ sendProductDeleted: mocks.productDeleted }));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));

import { processProductSync } from "../process-product-sync";

describe("deleted product inventory", () => {
  it("durably queues zero-stock writes instead of deleting provider catalog records", async () => {
    const sendEvent = vi.fn(async () => ({}));
    const step = {
      run: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()),
      sendEvent,
    };
    const run = processProductSync as unknown as (input: {
      event: Record<string, unknown>;
      step: typeof step;
    }) => Promise<Record<string, unknown>>;

    const result = await run({
      event: {
        id: "event-1",
        name: "shopify/product.deleted",
        data: {
          productId: "10",
          productTitle: "Deleted product",
          shopifyStore: "example.myshopify.com",
          receivedAt: "2026-10-28T00:00:00.000Z",
          productJson: {
            id: 10,
            title: "Deleted product",
            variants: [{ id: 20, sku: "IM8-1", inventory_item_id: 30 }],
          },
        },
      },
      step,
    });

    expect(result.status).toBe("deleted");
    expect(sendEvent).toHaveBeenCalledTimes(2);
    expect(sendEvent.mock.calls.map((call) => call[1].data.destination)).toEqual([
      "dynamics",
      "gps",
    ]);
    for (const [, queued] of sendEvent.mock.calls) {
      expect(queued.data.payload).toMatchObject({
        inventoryKey: "sku:IM8-1",
        sku: "IM8-1",
        quantity: 0,
        available: 0,
        action: "delete",
      });
    }
    expect(mocks.productDeleted).toHaveBeenCalledOnce();
  });
});
