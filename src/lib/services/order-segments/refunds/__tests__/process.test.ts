import { expect, it, vi } from "vitest";
const { read, line, report } = vi.hoisted(() => ({
  read: vi.fn(),
  line: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  config: {
    features: { dryRunMode: false, enableDynamicsSync: true, enableReturnInvoicePosting: false },
    dynamics: { baseUrl: "https://d365.example" },
  },
}));
vi.mock("@/lib/clients/dynamics", () => ({
  createSalesOrderLine: line,
  createFulfilment: async () => ({ response: { status: 1 } }),
}));
vi.mock("@/lib/clients/shopify", () => ({
  resolveShopifyAdminCredentials: () => ({ shopDomain: "shop" }),
}));
vi.mock("@/lib/db/database", () => ({ queryDatabase: async () => ({ rowCount: 1 }) }));
vi.mock("@/lib/helpers/warehouse", () => ({
  getWarehouseConfig: () => ({ return: {} }),
  resolveRefundSkuAudit: () => ({ refundSku: "REFUND" }),
}));
vi.mock("@/lib/helpers/exchange", () => ({
  resolveRefundAmountUsd: () => ({ refundAmountUsd: 1, conversionApplied: false }),
}));
vi.mock("../../store", () => ({ readPlan: read }));
vi.mock("../store", () => ({
  reserveSegmentRefund: async () => ({
    completed: false,
    allocations: [{ segmentIndex: 0, amountCents: 100, quantities: {} }],
  }),
}));
vi.mock("../../../fulfillment-actions/ledger", () => ({
  executeFulfillmentAction: async (
    _identity: unknown,
    _request: unknown,
    execute: () => Promise<unknown>
  ) => execute(),
}));
vi.mock("../../../order-lines", () => ({ saveRefundOrderLine: report }));
import { refundOrderSegments } from "../process";
import { loadFixture } from "../../../../../../tests/fixtures";
it("refreshes incomplete progress on retry and checkpoints the successful refund/report", async () => {
  const stored = {
    plan: { segments: [{ index: 0, warehouse: "GPS Warehouse", dataAreaId: "U001" }] },
    progress: {},
  };
  read
    .mockResolvedValueOnce(stored)
    .mockResolvedValueOnce(stored)
    .mockResolvedValue({
      ...stored,
      progress: { "0": { completed: true, salesOrderNumber: "SO" } },
    });
  line.mockResolvedValue({ InventoryLotId: "LOT" });
  report.mockResolvedValue({ ok: true });
  const cache = new Map();
  const step = {
    run: async (id: string, execute: () => Promise<unknown>) => {
      if (!cache.has(id)) cache.set(id, await execute());
      return cache.get(id);
    },
  } as unknown as Parameters<typeof refundOrderSegments>[2];
  const order = loadFixture("multiLineOrder");
  const refund = {
    id: 1,
    order_id: order.id,
    created_at: "2026-10-28T00:00:00Z",
    refund_line_items: [],
    transactions: [],
  };
  await expect(refundOrderSegments(order, refund, step)).rejects.toThrow("target segment");
  expect(line).not.toHaveBeenCalled();
  expect((await refundOrderSegments(order, refund, step))?.status).toBe("completed");
  await refundOrderSegments(order, refund, step);
  expect(read).toHaveBeenCalledTimes(3);
  expect(line).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ refund_id: "1", segment_index: 0, is_fulfilled_to_dynamics: true })
  );
});
