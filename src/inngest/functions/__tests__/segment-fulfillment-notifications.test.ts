import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  hub: vi.fn(),
  paypal: vi.fn(async () => ({})),
  complete: vi.fn(),
  options: {} as Record<string, unknown>,
}));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (options: Record<string, unknown>, fn: unknown) => {
      mocks.options = options;
      return fn;
    },
  },
}));
vi.mock("@/lib/services/order-segments/fulfillment", () => ({
  fulfillOrderSegments: vi.fn(async () => ({
    results: [
      {
        status: "success",
        fulfillmentId: 99,
        trackingNumber: "TRACK",
        carrier: "UPS",
        source: "Direct",
      },
    ],
    d365Order: { SalesOrderNumber: "SO-1", dataAreaId: "H007" },
  })),
}));
vi.mock("@/lib/services/order-segments/completion", () => ({
  publishSegmentCompletion: mocks.complete,
}));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn(), logFlowEventSync: vi.fn() }));
vi.mock("@/lib/clients/cs-platform", () => ({ sendOrderFulfilled: mocks.hub }));
vi.mock("@/lib/clients/paypal", () => ({ isEnabled: () => true, syncTrackingBatch: mocks.paypal }));
vi.mock("@/lib/clients/shopify", () => ({
  getOrderTransactions: vi.fn(async () => [
    { id: "PAY", gateway: "paypal", kind: "sale", status: "success" },
  ]),
  resolveShopifyAdminCredentials: () => ({ shopDomain: "store" }),
}));
import { processShopifyFulfillment } from "../process-shopify-fulfillment";

describe("segment workflow completion", () => {
  it("retains Hub and PayPal tracking and has no lossy per-order rate limit", async () => {
    const run = processShopifyFulfillment as unknown as (args: unknown) => Promise<unknown>;
    const result = await run({
      event: {
        id: "event",
        data: {
          shopifyOrderId: "123",
          shopifyOrderName: "#123",
          orderJson: { name: "#123", financial_status: "paid", fulfillment_status: "partial" },
          fulfillments: [{ id: 99, location_id: 42, tracking_number: "TRACK", line_items: [] }],
        },
      },
      step: { run: async (_id: string, fn: () => Promise<unknown>) => fn() },
      runId: "run",
    });
    expect(result).toMatchObject({ status: "success" });
    expect(mocks.hub).toHaveBeenCalledWith(
      expect.objectContaining({ trackingNumber: "TRACK", shopifyFulfillmentStatus: "partial" })
    );
    expect(mocks.paypal).toHaveBeenCalledWith([
      expect.objectContaining({ trackingNumber: "TRACK" }),
    ]);
    expect(mocks.complete).toHaveBeenCalledWith("store", "123");
    expect(mocks.options.rateLimit).toBeUndefined();
    expect(mocks.options.throttle).toBeDefined();
  });
});
