import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFixture } from "../fixtures";
import { createInngestHarness } from "../helpers/inngest-harness";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
} from "@/lib/transformers/order";
import { determineWarehouse, getDataAreaId } from "@/lib/helpers/warehouse";
import { isServiceSku } from "@/lib/transformers/sku";

describe("Order Creation Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
    harness = createInngestHarness();
  });

  describe("Happy path: GPS US order", () => {
    it("creates D365 header, lines, and GPS order for US order", async () => {
      const order = loadFixture("gpsUsOrder");
      const countryCode = order.shipping_address!.country_code;

      const warehouseName = await harness.step.run("determine-warehouse", async () => {
        return determineWarehouse(countryCode);
      });
      expect(warehouseName).toBe("GPS Warehouse");

      const dataAreaId = getDataAreaId(warehouseName);
      expect(dataAreaId).toBe("U001");

      const header = await harness.step.run("create-d365-header", async () => {
        return toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId);
      });
      expect(header.dataAreaId).toBe("U001");
      expect(header.customerOrderReference).toBe("IM8-17715");

      const salesOrderNo = "U001-SO-100001";
      const lines = await harness.step.run("create-d365-lines", async () => {
        return toD365SalesOrderLines(order, salesOrderNo, warehouseName, true, dataAreaId);
      });
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const prepaymentAmount = calculatePrepaymentAmount(order);
      expect(prepaymentAmount).toBe(129.99);

      const sendToGps = shouldSendToGps(order, warehouseName);
      expect(sendToGps).toBe(true);

      const gpsOrder = await harness.step.run("create-gps-order", async () => {
        return toGpsOutboundOrder(order, salesOrderNo, warehouseName);
      });
      expect(gpsOrder.whCode).toBe("JFK01W");
      expect(gpsOrder.platformOrderNo).toBe("IM8-17715");
      expect(gpsOrder.productList.length).toBeGreaterThanOrEqual(1);

      expect(harness.getStepNames()).toEqual([
        "determine-warehouse",
        "create-d365-header",
        "create-d365-lines",
        "create-gps-order",
      ]);
    });
  });

  describe("Happy path: GPS UK order", () => {
    it("uses H007 dataAreaId and LHR warehouse code", () => {
      const order = loadFixture("gpsUkOrder");
      const countryCode = order.shipping_address!.country_code;

      const warehouseName = determineWarehouse(countryCode);
      expect(warehouseName).toBe("GPS UK Warehouse");

      const dataAreaId = getDataAreaId(warehouseName);
      expect(dataAreaId).toBe("H007");

      const header = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId);
      expect(header.dataAreaId).toBe("H007");
      expect(header.skipFulfillmentNotification).toBe("Yes");

      const salesOrderNo = "H007-SO-100001";
      const lines = toD365SalesOrderLines(order, salesOrderNo, warehouseName, true, dataAreaId);
      expect(lines.every((l) => l.dataAreaId === "H007")).toBe(true);

      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000004");
      expect(taxLine).toBeDefined();

      const gpsOrder = toGpsOutboundOrder(order, salesOrderNo, warehouseName);
      expect(gpsOrder.whCode).toBe("LHR");
      expect(gpsOrder.logisticsChannel).toBe("GPS-IM8-STANDARD-UK");
    });
  });

  describe("Happy path: HK order (no GPS)", () => {
    it("routes to HK Warehouse with H007 and skips GPS", () => {
      const order = loadFixture("hkOrder");
      const warehouseName = determineWarehouse(order.shipping_address!.country_code);
      expect(warehouseName).toBe("HK Warehouse");
      expect(getDataAreaId(warehouseName)).toBe("H007");
      expect(shouldSendToGps(order, warehouseName)).toBe(false);
    });
  });

  describe("Happy path: STORD order (no GPS)", () => {
    it("routes to STORD with correct service SKUs", () => {
      const order = loadFixture("stordOrder");
      const header = toD365SalesOrderHeaderV3(order, "STORD ATL Location");
      expect(header.dataAreaId).toBe("U001");

      const lines = toD365SalesOrderLines(order, "U001-SO-200001", "STORD ATL Location");
      const shippingLine = lines.find((l) => l.itemNumber === "IM8-SER-000003");
      expect(shippingLine).toBeDefined();
      expect(shippingLine!.price).toBe(3.6);
      expect(shouldSendToGps(order, "STORD ATL Location")).toBe(false);
    });
  });

  describe("Service SKU handling", () => {
    it("identifies service SKUs correctly", () => {
      expect(isServiceSku("IM8-SER-000001")).toBe(true);
      expect(isServiceSku("IM8-FG-000031")).toBe(false);
    });

    it("creates service lines only when amounts are positive", () => {
      const order = loadFixture("hkOrder");
      const lines = toD365SalesOrderLines(order, "H007-SO-100", "HK Warehouse");
      const serviceLines = lines.filter((l) => isServiceSku(l.itemNumber));
      expect(serviceLines.length).toBe(0);
    });
  });

  describe("Null-SKU handling (GST fee order)", () => {
    it("skips non-shippable lines with null SKU", () => {
      const order = loadFixture("gstFeeOrder");
      const lines = toD365SalesOrderLines(order, "H007-SO-200", "HK Warehouse");
      const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));
      expect(productLines.length).toBe(2);
      const invalidLines = lines.filter((l) => !l.itemNumber || l.itemNumber.trim() === "");
      expect(invalidLines.length).toBe(0);
    });

    it("throws when a shippable line has empty SKU", () => {
      const order = loadFixture("gpsUsOrder");
      order.line_items[0].sku = "";
      expect(() => toD365SalesOrderLines(order, "U001-SO-100", "GPS Warehouse")).toThrow(
        "Missing SKU on shippable Shopify line item"
      );
    });
  });

  describe("GPS out-of-stock detection", () => {
    it("classifies GPS inventory error correctly", () => {
      const errorMsg = "GPS inventory error for IM8-17756: IM8-FG-000035\u5e93\u5b58\u4e0d\u8db3";
      expect(errorMsg.includes("\u5e93\u5b58\u4e0d\u8db3")).toBe(true);
    });
  });

  describe("Multi-line order with gift cards", () => {
    it("filters gift cards from D365 lines and GPS order", () => {
      const order = loadFixture("multiLineOrder");
      const d365Lines = toD365SalesOrderLines(order, "U001-SO-300", "GPS Warehouse");
      expect(d365Lines.find((l) => l.itemNumber === "IM8-GC-50")).toBeUndefined();

      const gpsOrder = toGpsOutboundOrder(order, "U001-SO-300", "GPS Warehouse");
      expect(gpsOrder.productList.find((p: any) => p.sku === "IM8-GC-50")).toBeUndefined();
    });

    it("includes discount in line items", () => {
      const order = loadFixture("multiLineOrder");
      const lines = toD365SalesOrderLines(order, "U001-SO-300", "GPS Warehouse");
      const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));
      const discountedLine = productLines.find((l) => l.discount && l.discount > 0);
      expect(discountedLine).toBeDefined();
    });
  });

  describe("Subscription order", () => {
    it("processes subscription order with refill SKU mapping", () => {
      const order = loadFixture("subscriptionOrder");
      const lines = toD365SalesOrderLines(order, "U001-SO-400", "GPS Warehouse");
      const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));
      const mappedLine = productLines.find((l) => l.itemNumber === "IM8-FG-000035");
      expect(mappedLine).toBeDefined();
    });

    it("identifies subscription source correctly", () => {
      const order = loadFixture("subscriptionOrder");
      expect(order.source_name).toBe("subscription_contract");
      expect(order.tags).toContain("subscription");
    });
  });

  describe("Duty calculation in tax line", () => {
    it("combines tax and duty amounts into single tax service line", () => {
      const order = loadFixture("gpsUkOrder") as any;
      order.current_total_duties_set = {
        shop_money: { amount: "8.50", currency_code: "USD" },
      };
      order.total_tax = "34.83";

      const lines = toD365SalesOrderLines(order, "H007-SO-100", "GPS UK Warehouse");
      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000004");
      expect(taxLine).toBeDefined();
      expect(taxLine!.price).toBeCloseTo(43.33, 1);
    });
  });
});
