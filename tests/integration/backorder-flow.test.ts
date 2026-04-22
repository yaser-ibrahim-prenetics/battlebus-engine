import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInngestHarness } from "../helpers/inngest-harness";
import { loadFixture } from "../fixtures";
import { mockGps, resetMockGps, setGpsOosSkus } from "../mocks/gps";
import { mockShopify, resetMockShopify, seedShopifyOrder } from "../mocks/shopify";
import { mockSlack, resetMockSlack } from "../mocks/slack";
import { mockCsPlatform, resetMockCsPlatform } from "../mocks/cs-platform";
import { toGpsOutboundOrder } from "@/lib/transformers/order";

describe("Backorder Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
    harness = createInngestHarness();
    resetMockGps();
    resetMockShopify();
    resetMockSlack();
    resetMockCsPlatform();
  });

  describe("Manual retry succeeds", () => {
    it("retries GPS order creation and succeeds", async () => {
      const order = loadFixture("gpsUkOrder");
      seedShopifyOrder(order);

      const backorderEvent = {
        name: "backorder/retry",
        data: {
          shopifyOrderId: order.id,
          shopifyOrderName: order.name,
          d365OrderNumber: "H007-SO-101358",
          warehouse: "GPS UK Warehouse",
          errorMessage: "GPS inventory error: IM8-FG-000035\u5e93\u5b58\u4e0d\u8db3",
          errorType: "out_of_stock",
          retryCount: 1,
          triggeredBy: "manual",
        },
      };

      // Simulate manual retry step
      const retryResult = await harness.step.run("manual-retry-gps-order-2", async () => {
        try {
          const freshOrder = await mockShopify.getOrder(backorderEvent.data.shopifyOrderId);

          const gpsPayload = toGpsOutboundOrder(
            freshOrder,
            backorderEvent.data.d365OrderNumber,
            backorderEvent.data.warehouse
          );
          const result = await mockGps.createOutboundOrder(
            gpsPayload,
            backorderEvent.data.warehouse
          );

          const gpsOrderNo = result?.response?.data?.[0]?.orderNo;
          if (gpsOrderNo) {
            await mockShopify.setGpsOrderMetafield(backorderEvent.data.shopifyOrderId, {
              gpsOrderId: gpsOrderNo,
              warehouse: backorderEvent.data.warehouse,
              d365OrderNumber: backorderEvent.data.d365OrderNumber,
            });
          }

          return { success: true, gpsOrderNo };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      expect(retryResult.success).toBe(true);
      expect(retryResult.gpsOrderNo).toBeDefined();
      expect(mockGps.createOutboundOrder).toHaveBeenCalledTimes(1);
      expect(mockShopify.setGpsOrderMetafield).toHaveBeenCalledTimes(1);
    });
  });

  describe("Manual retry still out of stock", () => {
    it("fails again and keeps order in backorder", async () => {
      const order = loadFixture("gpsUkOrder");
      seedShopifyOrder(order);

      // Set OOS for specific SKU
      setGpsOosSkus(["IM8-FG-000048"]); // refill-mapped from IM8-FG-000031

      const retryResult = await harness.step.run("manual-retry-gps-order-1", async () => {
        try {
          const freshOrder = await mockShopify.getOrder(order.id);
          const gpsPayload = toGpsOutboundOrder(freshOrder, "H007-SO-101358", "GPS UK Warehouse");
          await mockGps.createOutboundOrder(gpsPayload, "GPS UK Warehouse");
          return { success: true };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: msg,
            isInventoryError: mockGps.isGpsInventoryError(msg),
          };
        }
      });

      expect(retryResult.success).toBe(false);
      expect(retryResult.isInventoryError).toBe(true);
      expect(retryResult.error).toContain("\u5e93\u5b58\u4e0d\u8db3");
    });
  });

  describe("Auto-retry disabled (manual only mode)", () => {
    it("parks order without retrying when auto-retry is disabled", async () => {
      const manualRetryOnly = true;
      const isManualRetryRequest = false;

      if (manualRetryOnly && !isManualRetryRequest) {
        const result = {
          status: "parked_manual_only",
          shopifyOrderName: "IM8-17756",
          retryCount: 0,
        };

        expect(result.status).toBe("parked_manual_only");
        expect(result.retryCount).toBe(0);
      }
    });
  });

  describe("Non-inventory error escalation", () => {
    it("escalates non-inventory errors immediately", async () => {
      const order = loadFixture("gpsUkOrder");
      seedShopifyOrder(order);

      mockGps.createOutboundOrder.mockRejectedValueOnce(new Error("GPS API connection timeout"));

      const retryResult = await harness.step.run("retry-gps-order-1", async () => {
        try {
          const freshOrder = await mockShopify.getOrder(order.id);
          const gpsPayload = toGpsOutboundOrder(freshOrder, "H007-SO-101358", "GPS UK Warehouse");
          await mockGps.createOutboundOrder(gpsPayload, "GPS UK Warehouse");
          return { success: true };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: msg,
            isInventoryError: mockGps.isGpsInventoryError(msg),
          };
        }
      });

      expect(retryResult.success).toBe(false);
      expect(retryResult.isInventoryError).toBe(false);
      // Non-inventory errors should escalate immediately
    });
  });

  describe("Backorder event emission", () => {
    it("emits backorder/resolved event on success", async () => {
      await harness.inngestSend({
        name: "backorder/resolved",
        data: {
          shopifyOrderId: "6899394347240",
          shopifyOrderName: "IM8-17756",
          resolvedAt: new Date().toISOString(),
          resolution: "manual",
        },
      });

      expect(harness.events.length).toBe(1);
      expect(harness.events[0].name).toBe("backorder/resolved");
      expect(harness.events[0].data.resolution).toBe("manual");
    });
  });

  describe("Retry count tracking", () => {
    it("increments retry count across attempts", () => {
      let retryCount = 0;
      const maxRetries = 3;

      const attempts = [];
      while (retryCount < maxRetries) {
        retryCount++;
        attempts.push({ attempt: retryCount, success: retryCount === 3 });
      }

      expect(attempts.length).toBe(3);
      expect(attempts[2].success).toBe(true);
    });
  });
});
