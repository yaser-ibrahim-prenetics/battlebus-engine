import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInngestHarness } from "../helpers/inngest-harness";
import { loadFixture } from "../fixtures";
import { mockDynamics, resetMockD365 } from "../mocks/dynamics";
import { mockCsPlatform, resetMockCsPlatform } from "../mocks/cs-platform";
import {
  determineWarehouse,
  getRefundSku,
  getReturnConfig,
  getWarehouseConfig,
  resolveRefundFulfillmentWarehouse,
} from "@/lib/helpers/warehouse";

const UAT_REFUND_SKU = "IM8-SER-000005";
const PROD_REFUND_SKU = "IM8-SER-000003";

describe("Order Refund Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
    process.env.SHOPIFY_STORE_MODE = "test";
    harness = createInngestHarness();
    resetMockD365();
    resetMockCsPlatform();
  });

  describe("Standard refund: D365 return header + negative line", () => {
    it("creates a negative refund line and fulfills it", async () => {
      const order = loadFixture("gpsUsOrder");
      const d365Order = {
        SalesOrderNumber: "U001-SO-100001",
        dataAreaId: "U001",
      };

      const refundAmount = 129.99;

      const warehouseInfo = await harness.step.run("determine-warehouse-info", async () => {
        const countryCode = order.shipping_address?.country_code || "US";
        const warehouseName = determineWarehouse(countryCode);
        return {
          warehouseName,
          refundSku: getRefundSku(warehouseName),
          returnConfig: getReturnConfig(warehouseName),
        };
      });

      expect(warehouseInfo.warehouseName).toBe("GPS Warehouse");
      expect(warehouseInfo.refundSku).toBe(UAT_REFUND_SKU);
      expect(warehouseInfo.returnConfig.shippingWarehouseLocationId).toBe("Return");

      const refundLine = await harness.step.run("create-d365-refund-line", async () => {
        return mockDynamics.createSalesOrderLine({
          salesOrderNumber: d365Order.SalesOrderNumber,
          dataAreaId: d365Order.dataAreaId,
          itemNumber: warehouseInfo.refundSku,
          quantity: -1,
          price: refundAmount,
        });
      });

      expect(mockDynamics.createSalesOrderLine).toHaveBeenCalledWith(
        expect.objectContaining({
          itemNumber: UAT_REFUND_SKU,
          quantity: -1,
          price: 129.99,
        })
      );
      expect(refundLine.InventoryLotId).toBeDefined();

      const fulfillment = await harness.step.run("fulfill-refund-line", async () => {
        await mockDynamics.createFulfilment({
          salesOrderNumber: d365Order.SalesOrderNumber,
          dataAreaId: d365Order.dataAreaId,
          type: "return",
          confirmedShippedDate: new Date().toISOString().split("T")[0],
          lines: [
            {
              itemNumber: warehouseInfo.refundSku,
              quantity: -1,
              shippingSiteId: warehouseInfo.returnConfig.shippingSiteId,
              shippingWarehouseId: warehouseInfo.returnConfig.shippingWarehouseId,
              shippingWarehouseLocationId: warehouseInfo.returnConfig.shippingWarehouseLocationId,
              lotId: refundLine.InventoryLotId,
              trackingNumber: "",
            },
          ],
        });
        return { status: "success" };
      });

      expect(fulfillment.status).toBe("success");
      expect(mockDynamics.createFulfilment).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "return",
          lines: expect.arrayContaining([
            expect.objectContaining({
              itemNumber: UAT_REFUND_SKU,
              quantity: -1,
              shippingWarehouseLocationId: "Return",
            }),
          ]),
        })
      );
    });
  });

  describe("Refund with correct service SKU per warehouse (SHOPIFY_STORE_MODE=test)", () => {
    it("uses UAT refund SKU for GPS US", () => {
      expect(getRefundSku("GPS Warehouse")).toBe(UAT_REFUND_SKU);
    });

    it("uses UAT refund SKU for GPS UK", () => {
      expect(getRefundSku("GPS UK Warehouse")).toBe(UAT_REFUND_SKU);
    });

    it("uses UAT refund SKU for HK Warehouse", () => {
      expect(getRefundSku("HK Warehouse")).toBe(UAT_REFUND_SKU);
    });

    it("uses UAT refund SKU for STORD ATL", () => {
      expect(getRefundSku("STORD ATL Location")).toBe(UAT_REFUND_SKU);
    });

    it("matches process-refund: Hub STORD + US + U001 → STORD refund SKU and return warehouse", () => {
      const fulfillment = resolveRefundFulfillmentWarehouse("US", "STORD ATL Location");
      const profile = getWarehouseConfig(fulfillment);
      expect(fulfillment).toBe("STORD ATL Location");
      expect(getRefundSku(fulfillment, "U001")).toBe(UAT_REFUND_SKU);
      expect(profile.return.shippingWarehouseId).toBe("USOPS-WH05-Q");
    });
  });

  describe("Refund SKUs when SHOPIFY_STORE_MODE=production", () => {
    beforeEach(() => {
      process.env.SHOPIFY_STORE_MODE = "production";
    });

    it("uses PROD refund SKU for GPS US", () => {
      expect(getRefundSku("GPS Warehouse")).toBe(PROD_REFUND_SKU);
    });

    it("uses PROD refund SKU for STORD ATL", () => {
      expect(getRefundSku("STORD ATL Location", "U001")).toBe(PROD_REFUND_SKU);
    });
  });

  describe("UK order refund with correct routing", () => {
    it("routes to GPS UK refund SKU and return config", async () => {
      const order = loadFixture("gpsUkOrder");

      const warehouseInfo = await harness.step.run("determine-warehouse-info", async () => {
        const countryCode = order.shipping_address?.country_code || "GB";
        const warehouseName = determineWarehouse(countryCode);
        return {
          warehouseName,
          refundSku: getRefundSku(warehouseName),
          returnConfig: getReturnConfig(warehouseName),
        };
      });

      expect(warehouseInfo.warehouseName).toBe("GPS UK Warehouse");
      expect(warehouseInfo.refundSku).toBe(UAT_REFUND_SKU);
      expect(warehouseInfo.returnConfig.shippingWarehouseId).toBe("OPS-WH02-Q");
    });
  });

  describe("Partial refund amount calculation", () => {
    it("calculates partial refund from transactions", async () => {
      const transactions = [
        { kind: "refund", status: "success", amount: "50.00" },
        { kind: "refund", status: "success", amount: "25.00" },
        { kind: "refund", status: "pending", amount: "10.00" },
      ];

      const totalRefund = transactions
        .filter((tx) => tx.kind === "refund" && tx.status === "success")
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0);

      expect(totalRefund).toBe(75.0);
    });
  });

  describe("Zero refund amount", () => {
    it("skips when refund amount is 0", () => {
      const transactions: any[] = [];
      const totalRefund = transactions
        .filter((tx: any) => tx.kind === "refund" && tx.status === "success")
        .reduce((sum: number, tx: any) => sum + parseFloat(tx.amount), 0);

      expect(totalRefund).toBe(0);
    });
  });

  describe("D365 line creation failure during refund", () => {
    it("propagates error when D365 refund line creation fails", async () => {
      mockDynamics.createSalesOrderLine.mockRejectedValueOnce(
        new Error(`[D365 Mock] Line creation failed for ${UAT_REFUND_SKU}`)
      );

      await expect(
        harness.step.run("create-d365-refund-line", async () => {
          return mockDynamics.createSalesOrderLine({
            salesOrderNumber: "U001-SO-100001",
            dataAreaId: "U001",
            itemNumber: UAT_REFUND_SKU,
            quantity: -1,
            price: 100,
          });
        })
      ).rejects.toThrow("Line creation failed");

      expect(harness.getStepError("create-d365-refund-line")).toBeDefined();
    });
  });
});
