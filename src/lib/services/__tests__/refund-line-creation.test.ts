import { beforeEach, describe, expect, it, vi } from "vitest";

import * as dynamics from "@/lib/clients/dynamics";
import {
  beginRefundLineCreation,
  markRefundLineCreated,
  type RefundOperationClaim,
} from "@/lib/services/refund-operations";
import { buildRefundLineIdempotencyKey, ensureRefundLineCreated } from "../refund-line-creation";

vi.mock("@/lib/clients/dynamics", () => ({
  createSalesOrderLine: vi.fn(),
  getSalesOrderLines: vi.fn(),
}));

vi.mock("@/lib/services/refund-operations", () => ({
  beginRefundLineCreation: vi.fn(),
  markRefundLineCreated: vi.fn(),
}));

const request = {
  salesOrderNumber: "SO-42",
  dataAreaId: "U001",
  itemNumber: "REFUND-SKU",
  quantity: -1,
  price: 42,
};

function operation(overrides: Partial<RefundOperationClaim> = {}): RefundOperationClaim {
  return {
    claimed: true,
    state: "processing",
    claimToken: "00000000-0000-0000-0000-000000000099",
    d365OrderNumber: null,
    inventoryLotId: null,
    externalIdempotencyKey: null,
    ...overrides,
  };
}

describe("refund line creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a stable non-sensitive D365 marker", () => {
    const first = buildRefundLineIdempotencyKey("gid://shopify/Refund/42");
    const second = buildRefundLineIdempotencyKey("gid://shopify/Refund/42");

    expect(first).toBe(second);
    expect(first).toMatch(/^SHOPIFY-REFUND-[a-f0-9]{24}$/);
    expect(first).not.toContain("gid://shopify/Refund/42");
  });

  it("checkpoints before the D365 POST and attaches the stable marker", async () => {
    vi.mocked(dynamics.getSalesOrderLines).mockResolvedValue([]);
    vi.mocked(beginRefundLineCreation).mockResolvedValue(operation({ state: "creating_line" }));
    vi.mocked(dynamics.createSalesOrderLine).mockResolvedValue({
      InventoryLotId: "LOT-42",
      request: {},
    });

    const result = await ensureRefundLineCreated({
      refundId: "refund-42",
      claimToken: operation().claimToken!,
      operation: operation(),
      request,
    });

    expect(vi.mocked(beginRefundLineCreation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dynamics.createSalesOrderLine).mock.invocationCallOrder[0]!
    );
    expect(dynamics.createSalesOrderLine).toHaveBeenCalledWith(
      expect.objectContaining({
        lineDescription: buildRefundLineIdempotencyKey("refund-42"),
      })
    );
    expect(markRefundLineCreated).toHaveBeenCalledWith(
      expect.objectContaining({ inventoryLotId: "LOT-42" })
    );
    expect(result.status).toBe("created");
  });

  it("reconciles an unacknowledged write instead of issuing another POST", async () => {
    const marker = buildRefundLineIdempotencyKey("refund-42");
    vi.mocked(dynamics.getSalesOrderLines).mockResolvedValue([
      {
        dataAreaId: "U001",
        SalesOrderNumber: "SO-42",
        ItemNumber: "REFUND-SKU",
        SalesQuantity: -1,
        SalesPrice: 42,
        LineDescription: marker,
        InventoryLotId: "LOT-42",
      },
    ]);

    const result = await ensureRefundLineCreated({
      refundId: "refund-42",
      claimToken: operation().claimToken!,
      operation: operation({
        state: "creating_line",
        externalIdempotencyKey: marker,
      }),
      request,
    });

    expect(result).toMatchObject({ status: "reconciled", InventoryLotId: "LOT-42" });
    expect(dynamics.createSalesOrderLine).not.toHaveBeenCalled();
    expect(markRefundLineCreated).toHaveBeenCalledOnce();
  });

  it("refuses a duplicate POST while D365 visibility is uncertain", async () => {
    vi.mocked(dynamics.getSalesOrderLines).mockResolvedValue([]);

    await expect(
      ensureRefundLineCreated({
        refundId: "refund-42",
        claimToken: operation().claimToken!,
        operation: operation({
          state: "creating_line",
          externalIdempotencyKey: buildRefundLineIdempotencyKey("refund-42"),
        }),
        request,
      })
    ).rejects.toThrow("refusing a duplicate D365 write");

    expect(dynamics.createSalesOrderLine).not.toHaveBeenCalled();
    expect(markRefundLineCreated).not.toHaveBeenCalled();
  });

  it("resumes downstream work from a recorded line without calling D365", async () => {
    const result = await ensureRefundLineCreated({
      refundId: "refund-42",
      claimToken: operation().claimToken!,
      operation: operation({ state: "line_created", inventoryLotId: "LOT-42" }),
      request,
    });

    expect(result).toMatchObject({ status: "resumed", InventoryLotId: "LOT-42" });
    expect(dynamics.getSalesOrderLines).not.toHaveBeenCalled();
    expect(dynamics.createSalesOrderLine).not.toHaveBeenCalled();
  });
});
