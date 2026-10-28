import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), allocate: vi.fn() }));
vi.mock("@/lib/db/database", () => ({
  getDatabasePool: async () => ({ connect: async () => mocks }),
}));
vi.mock("../allocation", () => ({ allocateSegmentRefund: mocks.allocate }));
import { reserveSegmentRefund } from "../store";
import { fingerprint } from "../../../fulfillment-actions/identity";
import { readRefundsSQL } from "@/lib/sql/order-segments/refunds";
import type { StoredPlan } from "../../types";
import type { RefundOrder } from "../allocation";
import type { ShopifyRefundPayload } from "@/inngest/events";
const stored = { plan: { orderId: "1" } } as StoredPlan;
const order = { id: 1 } as RefundOrder;
const refund = { id: 2 } as ShopifyRefundPayload;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});
describe("durable refund reservation", () => {
  it("replays the saved allocation without recalculating or inserting", async () => {
    const allocations = [{ segmentIndex: 1, amountCents: 101, quantities: { line: 1 } }];
    mocks.query.mockImplementation(async (sql) => ({
      rows:
        sql === readRefundsSQL
          ? [
              {
                refund_id: "2",
                request_hash: fingerprint({ refund, amountCents: 101, plan: stored.plan }),
                allocations,
                completed: false,
              },
            ]
          : [],
    }));
    expect((await reserveSegmentRefund("shop", stored, order, refund, 101)).allocations).toEqual(
      allocations
    );
    expect(mocks.allocate).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.map((c) => c[0]).some((sql) => sql.startsWith("INSERT"))).toBe(
      false
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects changed retries and rolls back under the order lock", async () => {
    mocks.query.mockImplementation(async (sql) => ({
      rows: sql === readRefundsSQL ? [{ refund_id: "2", request_hash: "changed" }] : [],
    }));
    await expect(reserveSegmentRefund("shop", stored, order, refund, 101)).rejects.toThrow(
      "changed"
    );
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.allocate).not.toHaveBeenCalled();
  });
});
