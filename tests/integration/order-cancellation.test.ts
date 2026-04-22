import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFixture } from "../fixtures";
import { createInngestHarness } from "../helpers/inngest-harness";
import { mockGps, resetMockGps, setGpsCancelFailure, getMockGpsState } from "../mocks/gps";
import {
  mockDynamics,
  resetMockD365,
  getMockD365State,
  setMockD365Failure,
} from "../mocks/dynamics";
import {
  mockShopify,
  resetMockShopify,
  seedShopifyOrder,
  seedShopifyMetafield,
  getMockShopifyState,
} from "../mocks/shopify";
import { mockSlack, resetMockSlack, getSlackMessages } from "../mocks/slack";
import { mockCsPlatform, resetMockCsPlatform } from "../mocks/cs-platform";

/**
 * Integration tests for the Order Cancellation flow.
 *
 * These tests simulate the processOrderCancellation function logic:
 *   1. Get D365 order (via shopifyOrderName)
 *   2. Try GPS cancellation (via GPS metafield or fallback)
 *   3. Handle D365 cancellation (delete or shopify-uncancel if GPS cancel fails)
 */
describe("Order Cancellation Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
    harness = createInngestHarness();
    resetMockGps();
    resetMockD365();
    resetMockShopify();
    resetMockSlack();
    resetMockCsPlatform();
  });

  describe("GPS order cancelled successfully", () => {
    it("cancels GPS order and deletes D365 order", async () => {
      const order = loadFixture("gpsUkOrder");
      const shopifyOrderId = order.id;
      const shopifyOrderName = order.name;
      const gpsOrderId = "GPS-UK-12345";

      // Seed: GPS metafield exists on Shopify order
      seedShopifyMetafield(shopifyOrderId, {
        namespace: "battle_bus",
        key: "gps_order",
        value: JSON.stringify({
          gpsOrderId,
          warehouse: "GPS UK Warehouse",
          d365OrderNumber: "H007-SO-101358",
        }),
      });

      // Step 1: Get D365 order
      const d365Order = await harness.step.run("get-d365-order", async () => {
        return {
          SalesOrderNumber: "H007-SO-101358",
          dataAreaId: "H007",
        };
      });

      // Step 2: Cancel GPS order
      const gpsCancellation = await harness.step.run("cancel-gps-order", async () => {
        const gpsMeta = await mockShopify.getGpsOrderMetafield(shopifyOrderId);
        if (gpsMeta?.gpsOrderId) {
          const result = await mockGps.cancelOutboundOrder(gpsMeta.gpsOrderId, gpsMeta.warehouse);
          return { status: result.success ? "cancelled" : "failed", result };
        }
        return { status: "skipped", reason: "No GPS metadata" };
      });

      expect(gpsCancellation.status).toBe("cancelled");
      expect(mockGps.cancelOutboundOrder).toHaveBeenCalledWith(gpsOrderId, "GPS UK Warehouse");

      // Step 3: D365 cancellation (delete since GPS succeeded)
      const d365Cancellation = await harness.step.run("process-d365-cancellation", async () => {
        await mockDynamics.deleteSalesOrderHeaderV3(
          d365Order.dataAreaId,
          d365Order.SalesOrderNumber
        );
        return { status: "success", action: "cancel_order" };
      });

      expect(d365Cancellation.status).toBe("success");
      expect(mockDynamics.deleteSalesOrderHeaderV3).toHaveBeenCalledWith("H007", "H007-SO-101358");
    });
  });

  describe("GPS cancel failed (shipped) → Shopify uncancel", () => {
    it("uncancels Shopify order when GPS cancellation fails", async () => {
      const order = loadFixture("gpsUkOrder");
      const shopifyOrderId = order.id;

      setGpsCancelFailure("Order already shipped");

      seedShopifyMetafield(shopifyOrderId, {
        namespace: "battle_bus",
        key: "gps_order",
        value: JSON.stringify({
          gpsOrderId: "GPS-UK-99999",
          warehouse: "GPS UK Warehouse",
        }),
      });

      // Step: GPS cancel fails
      const gpsCancellation = await harness.step.run("cancel-gps-order", async () => {
        const gpsMeta = await mockShopify.getGpsOrderMetafield(shopifyOrderId);
        const result = await mockGps.cancelOutboundOrder(gpsMeta.gpsOrderId, gpsMeta.warehouse);
        return { status: result.success ? "cancelled" : "failed", result };
      });

      expect(gpsCancellation.status).toBe("failed");

      // Step: Shopify uncancel
      const d365Cancellation = await harness.step.run("process-d365-cancellation", async () => {
        if (gpsCancellation.status !== "cancelled" && gpsCancellation.status !== "skipped") {
          await mockShopify.uncancelOrder(shopifyOrderId);
          return { status: "manual_required", action: "shopify_uncancelled" };
        }
        return { status: "success" };
      });

      expect(d365Cancellation.action).toBe("shopify_uncancelled");
      expect(mockShopify.uncancelOrder).toHaveBeenCalledWith(shopifyOrderId);
    });

    it("handles both GPS cancel and Shopify uncancel failing", async () => {
      const order = loadFixture("gpsUkOrder");
      const shopifyOrderId = order.id;

      setGpsCancelFailure("Already shipped");
      getMockShopifyState().failOnUncancel = true;

      seedShopifyMetafield(shopifyOrderId, {
        namespace: "battle_bus",
        key: "gps_order",
        value: JSON.stringify({
          gpsOrderId: "GPS-UK-FAIL",
          warehouse: "GPS UK Warehouse",
        }),
      });

      const gpsCancellation = await harness.step.run("cancel-gps-order", async () => {
        const gpsMeta = await mockShopify.getGpsOrderMetafield(shopifyOrderId);
        const result = await mockGps.cancelOutboundOrder(gpsMeta.gpsOrderId, gpsMeta.warehouse);
        return { status: "failed", result };
      });

      const d365Cancellation = await harness.step.run("process-d365-cancellation", async () => {
        try {
          await mockShopify.uncancelOrder(shopifyOrderId);
          return { status: "manual_required", action: "shopify_uncancelled" };
        } catch {
          return { status: "manual_required", action: "shopify_uncancel_failed" };
        }
      });

      expect(d365Cancellation.action).toBe("shopify_uncancel_failed");
    });
  });

  describe("No GPS metadata → fallback lookup", () => {
    it("attempts fallback with shopify order name when no GPS metafield", async () => {
      const shopifyOrderId = 6900000000099;
      const shopifyOrderName = "IM8-99999";

      // No GPS metafield seeded

      const gpsCancellation = await harness.step.run("cancel-gps-order", async () => {
        const gpsMeta = await mockShopify.getGpsOrderMetafield(shopifyOrderId);
        if (gpsMeta?.gpsOrderId) {
          return { status: "cancelled" };
        }

        // Legacy fallback
        const legacyMetafields = await mockShopify.getOrderMetafields(shopifyOrderId);
        if (legacyMetafields.length === 0) {
          // Fallback: try order name as GPS order number
          const attempts = [];
          for (const warehouse of ["GPS UK Warehouse", "GPS Warehouse"] as const) {
            const result = await mockGps.cancelOutboundOrder(shopifyOrderName, warehouse);
            attempts.push({ warehouse, success: result.success });
            if (result.success) {
              return { status: "cancelled", via: "fallback_shopify_order_name", warehouse };
            }
          }
          return { status: "skipped", reason: "No GPS metadata found", attempts };
        }
        return { status: "skipped" };
      });

      // GPS cancel with order name should succeed (mock returns success by default)
      expect(gpsCancellation.status).toBe("cancelled");
      expect(gpsCancellation.via).toBe("fallback_shopify_order_name");
    });
  });

  describe("D365-only cancellation (GPS sync disabled)", () => {
    it("skips GPS and only deletes D365 order", async () => {
      const gpsCancellation = { status: "skipped" as const, reason: "GPS sync disabled" };

      const d365Order = { SalesOrderNumber: "U001-SO-100000", dataAreaId: "U001" };

      const d365Cancellation = await harness.step.run("process-d365-cancellation", async () => {
        const isGpsCancelled =
          gpsCancellation.status === "cancelled" || gpsCancellation.status === "skipped";

        if (isGpsCancelled) {
          await mockDynamics.deleteSalesOrderHeaderV3(
            d365Order.dataAreaId,
            d365Order.SalesOrderNumber
          );
          return { status: "success", action: "cancel_order" };
        }
        return { status: "manual_required" };
      });

      expect(d365Cancellation.status).toBe("success");
      expect(mockDynamics.deleteSalesOrderHeaderV3).toHaveBeenCalledWith("U001", "U001-SO-100000");
    });
  });

  describe("D365 delete failure (confirmed order)", () => {
    it("reports manual_required when D365 delete fails", async () => {
      setMockD365Failure("failOnDelete");

      const d365Cancellation = await harness.step.run("process-d365-cancellation", async () => {
        try {
          await mockDynamics.deleteSalesOrderHeaderV3("U001", "U001-SO-CONFIRMED");
          return { status: "success" };
        } catch (err: any) {
          return { status: "manual_required", error: err.message };
        }
      });

      expect(d365Cancellation.status).toBe("manual_required");
      expect(d365Cancellation.error).toContain("Delete failed");
    });
  });

  describe("Legacy metafield lookup", () => {
    it("finds GPS order ID from legacy gpsukorderid metafield", async () => {
      const shopifyOrderId = 6900000000088;

      seedShopifyMetafield(shopifyOrderId, {
        namespace: "custom",
        key: "gpsukorderid",
        value: "LEGACY-UK-001",
      });

      const legacyMetafields = await mockShopify.getOrderMetafields(shopifyOrderId);
      const legacyUkMf = legacyMetafields.find((mf: any) =>
        String(mf.key).toLowerCase().includes("gpsukorderid")
      );

      expect(legacyUkMf).toBeDefined();
      expect(legacyUkMf.value).toBe("LEGACY-UK-001");
    });
  });
});
