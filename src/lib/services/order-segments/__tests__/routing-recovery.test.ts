import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../../../../tests/fixtures";
import type { IShopifyFulfillmentOrder } from "@/lib/types/shopify";
const mocks = vi.hoisted(() => ({
  warehouse: vi.fn(),
  area: vi.fn(),
  eu: vi.fn(),
  fallback: vi.fn(),
  order: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("@/lib/services/location-routing", () => ({
  getWarehouseNameForLocation: mocks.warehouse,
  getDataAreaIdForLocationAndCountry: mocks.area,
  resolveStordEuOverrideForMappedLocation: mocks.eu,
  resolveStordHubWhenFulfillmentLocationUnmapped: mocks.fallback,
}));
vi.mock("@/lib/clients/shopify", () => ({ getOrder: mocks.order }));
vi.mock("@/lib/utils/validation", () => ({ validateOrderCompletely: mocks.validate }));
import { resolveSegmentRouting } from "../routing";
import { loadEligibleRecoveryOrder } from "../recovery";
import { orderInputHash } from "../planner";

describe("segment routing and recovery eligibility", () => {
  beforeEach(() => vi.resetAllMocks());
  it("preserves the existing STORD Europe override", async () => {
    mocks.warehouse.mockResolvedValue("STORD ATL Location");
    mocks.area.mockResolvedValue("U001");
    mocks.eu.mockResolvedValue({ warehouseName: "STORD EU Location", dataAreaId: "H007" });
    expect(
      await resolveSegmentRouting(
        loadFixture("multiLineOrder"),
        { assigned_location_id: 12 } as IShopifyFulfillmentOrder,
        "GB"
      )
    ).toEqual({ warehouse: "STORD EU Location", dataAreaId: "H007" });
  });
  it("preserves unmapped STORD fallback for the selected fulfillment lines", async () => {
    mocks.fallback.mockResolvedValue({ warehouseName: "STORD ATL Location", dataAreaId: "U001" });
    const order = loadFixture("multiLineOrder");
    const result = await resolveSegmentRouting(
      order,
      {
        assigned_location_id: 12,
        line_items: [{ line_item_id: order.line_items[0].id }],
      } as IShopifyFulfillmentOrder,
      "US"
    );
    expect(result.warehouse).toBe("STORD ATL Location");
    expect(mocks.fallback.mock.calls[0][0].line_items).toHaveLength(1);
  });
  it("rejects cancellation, refunded payment state and risk holds on fresh recovery reads", async () => {
    const order = loadFixture("multiLineOrder");
    order.cancelled_at = null;
    order.financial_status = "paid";
    const hash = orderInputHash(order);
    mocks.order.mockResolvedValue({ ...order, cancelled_at: "2026-10-27T01:00:00Z" });
    await expect(loadEligibleRecoveryOrder("store", String(order.id), hash)).rejects.toThrow(
      "uncancelled"
    );
    mocks.order.mockResolvedValue({ ...order, financial_status: "refunded" });
    await expect(loadEligibleRecoveryOrder("store", String(order.id), hash)).rejects.toThrow(
      "paid"
    );
    mocks.order.mockResolvedValue(order);
    mocks.validate.mockResolvedValue({ valid: false, reason: "High risk" });
    await expect(loadEligibleRecoveryOrder("store", String(order.id), hash)).rejects.toThrow(
      "High risk"
    );
    mocks.validate.mockResolvedValue({ valid: true, skip: false });
    await expect(loadEligibleRecoveryOrder("store", String(order.id), hash)).resolves.toEqual(
      order
    );
    expect(mocks.validate).toHaveBeenLastCalledWith(order, String(order.id), order.name, "store");
  });
});
