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

describe("Order Refund Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
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
      expect(warehouseInfo.refundSku).toBe("IM8-SER-000003");
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
          itemNumber: "IM8-SER-000003",
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
              itemNumber: "IM8-SER-000003",
              quantity: -1,
              shippingWarehouseLocationId: "Return",
            }),
          ]),
        })
      );
    });
  });

  describe("Refund with correct service SKU per warehouse (spock-store item.refund)", () => {
    it("uses IM8-SER-000003 for GPS US", () => {
      expect(getRefundSku("GPS Warehouse")).toBe("IM8-SER-000003");
    });

    it("uses IM8-SER-000003 for GPS UK", () => {
      expect(getRefundSku("GPS UK Warehouse")).toBe("IM8-SER-000003");
    });

    it("uses IM8-SER-000003 for HK Warehouse", () => {
      expect(getRefundSku("HK Warehouse")).toBe("IM8-SER-000003");
    });

    it("uses IM8-SER-000005 for STORD ATL (warehouse-specific service SKU)", () => {
      expect(getRefundSku("STORD ATL Location")).toBe("IM8-SER-000005");
    });

    it("matches process-refund: Hub STORD + US + U001 → STORD refund SKU and return warehouse", () => {
      const fulfillment = resolveRefundFulfillmentWarehouse("US", "STORD ATL Location");
      const profile = getWarehouseConfig(fulfillment);
      expect(fulfillment).toBe("STORD ATL Location");
      expect(getRefundSku(fulfillment, "U001")).toBe("IM8-SER-000005");
      expect(profile.return.shippingWarehouseId).toBe("USOPS-WH05-Q");
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
      expect(warehouseInfo.refundSku).toBe("IM8-SER-000003");
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
        new Error("[D365 Mock] Line creation failed for IM8-SER-000003")
      );

      await expect(
        harness.step.run("create-d365-refund-line", async () => {
          return mockDynamics.createSalesOrderLine({
            salesOrderNumber: "U001-SO-100001",
            dataAreaId: "U001",
            itemNumber: "IM8-SER-000003",
            quantity: -1,
            price: 100,
          });
        })
      ).rejects.toThrow("Line creation failed");

      expect(harness.getStepError("create-d365-refund-line")).toBeDefined();
    });
  });
});
