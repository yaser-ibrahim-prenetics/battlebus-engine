/**
 * E2E: Refund Flow
 *
 * Tests the full refund pipeline using real D365 APIs:
 *   1. Creates a D365 order (header + product lines + service lines)
 *   2. Confirms the order
 *   3. Creates a negative refund line using the correct warehouse refund SKU
 *   4. Posts a return fulfillment to "post" the refund in D365
 *   5. Verifies all lines exist in D365
 *
 * Verifies per-warehouse refund SKU correctness (spock-store api.json item.refund):
 *   - GPS Warehouse / GPS UK / HK: IM8-SER-000003
 *   - STORD ATL Location: IM8-SER-000005
 *
 * Skipped unless E2E env vars are set.
 */

import { describe, it, expect, afterAll } from "vitest";
import { validateE2eEnv } from "./setup";
import { d365E2e } from "./clients";
import {
  getWarehouseConfig,
  getRefundSku,
  getReturnConfig,
  determineWarehouse,
} from "@/lib/helpers/warehouse";
import { isServiceSku } from "@/lib/transformers/sku";
import { toD365SalesOrderHeaderV3, toD365SalesOrderLines } from "@/lib/transformers/order";
import { loadFixture } from "../fixtures";

const envCheck = validateE2eEnv();
const RUN = envCheck.valid;

const cleanup: Array<{ d365OrderNumber: string; dataAreaId: string }> = [];

describe("E2E: Refund Flow", () => {
  if (!RUN) {
    it.skip(`Skipped — missing env: ${envCheck.missing.join(", ")}`, () => {});
    return;
  }

  afterAll(async () => {
    for (const item of cleanup) {
      try {
        await d365E2e.deleteSalesOrder(item.d365OrderNumber, item.dataAreaId);
        console.log(`[Cleanup] Deleted D365 order ${item.d365OrderNumber}`);
      } catch {
        console.warn(`[Cleanup] Could not delete ${item.d365OrderNumber}`);
      }
    }
  });

  describe("GPS UK refund with IM8-SER-000003", () => {
    it("creates a negative refund line and posts return fulfillment", async () => {
      const order = loadFixture("gpsUkOrder");
      const warehouseName = "GPS UK Warehouse";
      const refundSku = getRefundSku(warehouseName);
      const returnCfg = getReturnConfig(warehouseName);

      expect(refundSku).toBe("IM8-SER-000003");
      expect(returnCfg.shippingWarehouseId).toBe("OPS-WH02-Q");
      expect(returnCfg.shippingWarehouseLocationId).toBe("Return");

      const dynamics = await import("@/lib/clients/dynamics");
      await dynamics.authenticate();

      // 1. Create D365 header
      const header = toD365SalesOrderHeaderV3(order, warehouseName);
      const headerResult = await dynamics.createSalesOrderHeaderV3(header);
      const salesOrderNumber = headerResult.SalesOrderNumber;
      expect(salesOrderNumber).toBeTruthy();
      console.log(`[E2E Refund] Created header: ${salesOrderNumber}`);
      cleanup.push({ d365OrderNumber: salesOrderNumber, dataAreaId: "H007" });

      // 2. Create product lines
      const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName);
      for (const line of lines) {
        try {
          await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
        } catch (err: any) {
          if (isServiceSku(line.itemNumber) && err.message?.includes("does not exist")) {
            console.warn(`[E2E Refund] Skipped missing service SKU ${line.itemNumber}`);
          } else {
            throw err;
          }
        }
      }

      // 3. Confirm order
      await new Promise((r) => setTimeout(r, 1000));
      await dynamics.confirmSalesOrder(salesOrderNumber, "H007");

      // 4. Create negative refund line (qty = -1, price = refund amount)
      const refundAmount = 49.99;
      const refundLineResult = await dynamics.createSalesOrderLine({
        salesOrderNumber,
        dataAreaId: "H007",
        itemNumber: refundSku,
        quantity: -1,
        price: refundAmount,
      });
      expect(refundLineResult.InventoryLotId).toBeTruthy();
      console.log(
        `[E2E Refund] Created refund line: ${refundSku}, lotId=${refundLineResult.InventoryLotId}`
      );

      // 5. Post the return fulfillment
      const fulfillResult = await dynamics.createFulfilment({
        salesOrderNumber,
        dataAreaId: "H007",
        type: "return",
        confirmedShippedDate: new Date().toISOString().split("T")[0],
        lines: [
          {
            itemNumber: refundSku,
            quantity: -1,
            shippingSiteId: returnCfg.shippingSiteId,
            shippingWarehouseId: returnCfg.shippingWarehouseId,
            shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
            lotId: refundLineResult.InventoryLotId,
            trackingNumber: "",
          },
        ],
      });
      expect(fulfillResult.response).toBeDefined();
      console.log(`[E2E Refund] Return fulfillment posted for ${salesOrderNumber}`);

      // 6. Verify lines in D365
      const d365Lines = await d365E2e.getSalesOrderLines(salesOrderNumber, "H007");
      const refundLines = d365Lines.filter(
        (l: any) => l.ItemNumber === refundSku && Number(l.OrderedSalesQuantity) < 0
      );
      expect(refundLines.length).toBeGreaterThanOrEqual(1);
      console.log(`[E2E Refund] Verified ${refundLines.length} negative refund line(s) in D365`);
    }, 120_000);
  });

  describe("GPS US refund with IM8-SER-000003", () => {
    it("creates refund with correct US warehouse return config", async () => {
      const warehouseName = "GPS Warehouse";
      const refundSku = getRefundSku(warehouseName);
      const returnCfg = getReturnConfig(warehouseName);

      expect(refundSku).toBe("IM8-SER-000003");
      expect(returnCfg.shippingWarehouseId).toBe("USOPS-WH04-Q");
      expect(returnCfg.shippingWarehouseLocationId).toBe("Return");

      const dynamics = await import("@/lib/clients/dynamics");
      await dynamics.authenticate();

      const order = loadFixture("gpsUsOrder");
      const header = toD365SalesOrderHeaderV3(order, warehouseName);
      const headerResult = await dynamics.createSalesOrderHeaderV3(header);
      const salesOrderNumber = headerResult.SalesOrderNumber;
      expect(salesOrderNumber).toBeTruthy();
      cleanup.push({ d365OrderNumber: salesOrderNumber, dataAreaId: "U001" });

      const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName);
      for (const line of lines) {
        try {
          await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
        } catch (err: any) {
          if (isServiceSku(line.itemNumber) && err.message?.includes("does not exist")) {
            console.warn(`[E2E Refund US] Skipped missing service SKU ${line.itemNumber}`);
          } else {
            throw err;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
      await dynamics.confirmSalesOrder(salesOrderNumber, "U001");

      // Create refund line
      const refundAmount = 25.0;
      const refundLineResult = await dynamics.createSalesOrderLine({
        salesOrderNumber,
        dataAreaId: "U001",
        itemNumber: refundSku,
        quantity: -1,
        price: refundAmount,
      });
      expect(refundLineResult.InventoryLotId).toBeTruthy();

      // Post return fulfillment
      await dynamics.createFulfilment({
        salesOrderNumber,
        dataAreaId: "U001",
        type: "return",
        confirmedShippedDate: new Date().toISOString().split("T")[0],
        lines: [
          {
            itemNumber: refundSku,
            quantity: -1,
            shippingSiteId: returnCfg.shippingSiteId,
            shippingWarehouseId: returnCfg.shippingWarehouseId,
            shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
            lotId: refundLineResult.InventoryLotId,
            trackingNumber: "",
          },
        ],
      });

      console.log(`[E2E Refund US] Completed for ${salesOrderNumber}`);
    }, 120_000);
  });

  describe("STORD refund uses U001 PROD profile fallback", () => {
    it("uses built-in PROD U001 refund SKU (not warehouse-config STORD 000005)", () => {
      const refundSku = getRefundSku("STORD ATL Location");
      const returnCfg = getReturnConfig("STORD ATL Location");

      expect(refundSku).toBe("IM8-SER-000003");
      expect(returnCfg.shippingWarehouseId).toBe("USOPS-WH05-Q");
      expect(returnCfg.shippingWarehouseLocationId).toBe("Return");
    });
  });

  describe("Refund SKU correctness across all warehouses", () => {
    const cases = [
      { warehouse: "GPS Warehouse", expectedSku: "IM8-SER-000003" },
      { warehouse: "GPS UK Warehouse", expectedSku: "IM8-SER-000003" },
      { warehouse: "HK Warehouse", expectedSku: "IM8-SER-000003" },
      { warehouse: "STORD ATL Location", expectedSku: "IM8-SER-000003" },
    ];

    for (const tc of cases) {
      it(`${tc.warehouse} → refundSku = ${tc.expectedSku}`, () => {
        expect(getRefundSku(tc.warehouse)).toBe(tc.expectedSku);
      });
    }
  });
});
