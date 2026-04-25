import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLine,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculateShippingCost,
  calculateTaxAmount,
  calculateDutyAmount,
  calculatePrepaymentAmount,
  calculateOrderCost,
  shouldSendToGps,
  isTestOrder,
  isOrderTaggedWith,
} from "../order";
import { loadFixture } from "../../../../tests/fixtures";
import type { ShopifyOrderPayload } from "@/inngest/events";

describe("Order Transformers", () => {
  describe("toD365SalesOrderHeaderV3", () => {
    it("creates correct header for GPS US warehouse", () => {
      const order = loadFixture("gpsUsOrder");
      const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse");

      expect(header.dataAreaId).toBe("U001");
      expect(header.orderingCustomerAccountNumber).toBe("U001-C000000006");
      expect(header.customerOrderReference).toBe("IM8-17715");
      expect(header.email).toBe("test-us@example.com");
      expect(header.currency).toBe("USD");
      expect(header.shippingWarehouseId).toBe("USOPS-WH04");
      expect(header.shippingAddress).toBeDefined();
      expect(header.shippingAddress?.addressCountryCode).toBe("USA");
      expect(header.skipFulfillmentNotification).toBeUndefined();
    });

    it("creates correct header for GPS UK warehouse with H007", () => {
      const order = loadFixture("gpsUkOrder");
      const header = toD365SalesOrderHeaderV3(order, "GPS UK Warehouse");

      expect(header.dataAreaId).toBe("H007");
      expect(header.orderingCustomerAccountNumber).toBe("H007-C000000001");
      expect(header.customerOrderReference).toBe("IM8-17756");
      expect(header.skipFulfillmentNotification).toBe("Yes");
    });

    it("creates correct header for HK warehouse with H007", () => {
      const order = loadFixture("hkOrder");
      const header = toD365SalesOrderHeaderV3(order, "HK Warehouse");

      expect(header.dataAreaId).toBe("H007");
      expect(header.orderingCustomerAccountNumber).toBe("H005-C000000001");
    });

    it("creates correct header for STORD with U001", () => {
      const order = loadFixture("stordOrder");
      const header = toD365SalesOrderHeaderV3(order, "STORD ATL Location");

      expect(header.dataAreaId).toBe("U001");
      expect(header.orderingCustomerAccountNumber).toBe("U001-C000000006");
    });

    it("uses dataAreaIdOverride when provided", () => {
      const order = loadFixture("gpsUsOrder");
      const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse", "H007");

      expect(header.dataAreaId).toBe("H007");
      expect(header.orderingCustomerAccountNumber).toBe("H007-C000000001");
    });

    it("uses billing address when shipping address is null", () => {
      const order = loadFixture("gpsUsOrder");
      order.shipping_address = null;
      const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse");

      expect(header.name).toBe("John Smith");
      expect(header.shippingAddress).toBeDefined();
    });

    it("includes order comment with discount codes and notes", () => {
      const order = loadFixture("multiLineOrder");
      const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse");

      expect(header.comment).toContain("Discount Codes: SAVE10");
      expect(header.comment).toContain("Note: Birthday gift please wrap nicely");
    });

    it("includes gift card info in comment", () => {
      const order = loadFixture("multiLineOrder");
      const header = toD365SalesOrderHeaderV3(order, "GPS Warehouse");

      expect(header.comment).toContain("Gift Card Purchase");
    });
  });

  describe("toD365SalesOrderLine", () => {
    it("creates line with correct fields", () => {
      const line = toD365SalesOrderLine(
        {
          id: 1,
          variant_id: 1,
          title: "Test",
          quantity: 2,
          sku: "IM8-FG-000031",
          variant_title: null,
          vendor: null,
          fulfillment_service: "manual",
          product_id: 1,
          requires_shipping: true,
          taxable: true,
          gift_card: false,
          name: "Test",
          price: "49.99",
          total_discount: "5.00",
          fulfillment_status: null,
          properties: [],
          tax_lines: [],
        },
        "U001-SO-12345",
        "U001",
        "USD"
      );

      expect(line.salesOrderNumber).toBe("U001-SO-12345");
      expect(line.dataAreaId).toBe("U001");
      expect(line.quantity).toBe(2);
      expect(line.price).toBe(49.99);
      expect(line.discount).toBe(2.5); // 5/2 = 2.5 per unit
      expect(line.currency).toBe("USD");
    });

    it("omits discount when zero", () => {
      const line = toD365SalesOrderLine(
        {
          id: 1,
          variant_id: 1,
          title: "T",
          quantity: 1,
          sku: "IM8-FG-000031",
          variant_title: null,
          vendor: null,
          fulfillment_service: "manual",
          product_id: 1,
          requires_shipping: true,
          taxable: true,
          gift_card: false,
          name: "T",
          price: "49.99",
          total_discount: "0.00",
          fulfillment_status: null,
          properties: [],
          tax_lines: [],
        },
        "U001-SO-12345",
        "U001",
        "USD"
      );

      expect(line.discount).toBeUndefined();
    });
  });

  describe("toD365SalesOrderLines", () => {
    it("creates product lines and service lines for GPS US", () => {
      const order = loadFixture("gpsUsOrder");
      const lines = toD365SalesOrderLines(order, "U001-SO-100", "GPS Warehouse");

      const productLines = lines.filter((l) => !l.itemNumber.startsWith("IM8-SER-"));
      const serviceLines = lines.filter((l) => l.itemNumber.startsWith("IM8-SER-"));

      expect(productLines.length).toBeGreaterThanOrEqual(1);
      // Shipping line (9.99) and tax line (10.00) should exist
      expect(serviceLines.length).toBe(2);

      const shippingLine = serviceLines.find((l) => l.itemNumber === "IM8-SER-000002");
      expect(shippingLine).toBeDefined();
      expect(shippingLine!.price).toBe(9.99);

      const taxLine = serviceLines.find((l) => l.itemNumber === "IM8-SER-000001");
      expect(taxLine).toBeDefined();
      expect(taxLine!.price).toBe(10);

      expect(productLines.every((l) => l.shippingWarehouseId === "USOPS-WH04")).toBe(true);
      expect(serviceLines.every((l) => l.shippingWarehouseId === undefined)).toBe(true);
    });

    it("uses GPS UK service SKUs for UK orders", () => {
      const order = loadFixture("gpsUkOrder");
      const lines = toD365SalesOrderLines(order, "H007-SO-100", "GPS UK Warehouse");

      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000001");
      expect(taxLine).toBeDefined();
      expect(taxLine!.price).toBe(34.83);

      expect(lines.every((l) => l.dataAreaId === "H007")).toBe(true);
    });

    it("skips non-shippable lines with null SKU (GST fees)", () => {
      const order = loadFixture("gstFeeOrder");
      const lines = toD365SalesOrderLines(order, "H007-SO-200", "HK Warehouse");

      const nullSkuLines = lines.filter((l) => l.itemNumber === null || l.itemNumber === "");
      expect(nullSkuLines.length).toBe(0);

      const productSkus = lines
        .filter((l) => !l.itemNumber.startsWith("IM8-SER-"))
        .map((l) => l.itemNumber);
      expect(productSkus).toContain("IM8-FG-000064");
      expect(productSkus).toContain("IM8-FG-000035");
    });

    it("throws on shippable line with missing SKU", () => {
      const order = loadFixture("gpsUsOrder");
      order.line_items[0].sku = "";

      expect(() => toD365SalesOrderLines(order, "U001-SO-100", "GPS Warehouse")).toThrow(
        "Missing SKU on shippable Shopify line item"
      );
    });

    it("skips gift card lines", () => {
      const order = loadFixture("multiLineOrder");
      const lines = toD365SalesOrderLines(order, "U001-SO-300", "GPS Warehouse");

      const giftCardLine = lines.find((l) => l.itemNumber === "IM8-GC-50");
      expect(giftCardLine).toBeUndefined();
    });

    it("skips dummy IM8-FG-G* test SKUs (not released in D365), same as GPS path", () => {
      const order = loadFixture("gpsUsOrder");
      order.line_items = [
        {
          ...order.line_items[0],
          sku: "IM8-FG-G00003",
          title: "Placeholder test SKU",
        },
      ];
      const lines = toD365SalesOrderLines(order, "U001-SO-100", "GPS Warehouse");
      expect(lines.some((l) => l.itemNumber === "IM8-FG-G00003")).toBe(false);
    });

    it("omits shipping/tax lines when includeShippingAndTax is false", () => {
      const order = loadFixture("gpsUsOrder");
      const lines = toD365SalesOrderLines(order, "U001-SO-100", "GPS Warehouse", false);

      const serviceLines = lines.filter((l) => l.itemNumber.startsWith("IM8-SER-"));
      expect(serviceLines.length).toBe(0);
    });

    it("handles orders with zero shipping and zero tax", () => {
      const order = loadFixture("hkOrder");
      const lines = toD365SalesOrderLines(order, "H007-SO-100", "HK Warehouse");

      const shippingLines = lines.filter((l) => l.itemNumber === "IM8-SER-000002");
      expect(shippingLines.length).toBe(0);
    });
  });

  describe("toGpsOutboundOrder", () => {
    it("creates GPS order with correct fields for US order", () => {
      const order = loadFixture("gpsUsOrder");
      const gpsOrder = toGpsOutboundOrder(order, "U001-SO-100", "GPS Warehouse");

      expect(gpsOrder.platformOrderNo).toBe("IM8-17715");
      expect(gpsOrder.thirdOrderNo).toBe("U001-SO-100");
      expect(gpsOrder.whCode).toBe("JFK01W");
      expect(gpsOrder.logisticsChannel).toBe("GPS-IM8-STANDARD");
      expect(gpsOrder.subOrderType).toBe(1);
      expect(gpsOrder.receiver).toBe("John Smith");
      expect(gpsOrder.countryRegionCode).toBe("US");
      expect(gpsOrder.productList.length).toBeGreaterThanOrEqual(1);
    });

    it("creates GPS order with correct fields for UK order", () => {
      const order = loadFixture("gpsUkOrder");
      const gpsOrder = toGpsOutboundOrder(order, "H007-SO-200", "GPS UK Warehouse");

      expect(gpsOrder.whCode).toBe("LHR");
      expect(gpsOrder.logisticsChannel).toBe("GPS-IM8-STANDARD-UK");
      expect(gpsOrder.countryRegionCode).toBe("GB");
    });

    it("filters out gift card lines and service SKUs", () => {
      const order = loadFixture("multiLineOrder");
      const gpsOrder = toGpsOutboundOrder(order, "U001-SO-300", "GPS Warehouse");

      const skus = gpsOrder.productList.map((p: any) => p.sku);
      expect(skus).not.toContain("IM8-GC-50");
      expect(skus.every((s: string) => !s.startsWith("IM8-SER-"))).toBe(true);
    });

    it("merges duplicate SKU lines", () => {
      const order = loadFixture("gpsUsOrder");
      order.line_items.push({ ...order.line_items[0], id: 99999 });
      const gpsOrder = toGpsOutboundOrder(order, "U001-SO-100", "GPS Warehouse");

      const skuCounts = gpsOrder.productList.reduce((acc: Record<string, number>, p: any) => {
        acc[p.sku] = (acc[p.sku] || 0) + 1;
        return acc;
      }, {});

      Object.values(skuCounts).forEach((count) => {
        expect(count).toBe(1);
      });
    });

    it("throws when no shipping address available", () => {
      const order = loadFixture("gpsUsOrder");
      order.shipping_address = null;
      order.billing_address = null;

      expect(() => toGpsOutboundOrder(order, "U001-SO-100", "GPS Warehouse")).toThrow(
        "No shipping address"
      );
    });
  });

  describe("Calculation Helpers", () => {
    describe("calculateShippingCost", () => {
      it("sums shipping line prices", () => {
        const order = loadFixture("gpsUsOrder");
        expect(calculateShippingCost(order)).toBe(9.99);
      });

      it("returns 0 when no shipping lines", () => {
        const order = loadFixture("gpsUsOrder");
        order.shipping_lines = [];
        expect(calculateShippingCost(order)).toBe(0);
      });
    });

    describe("calculateTaxAmount", () => {
      it("returns total_tax from order", () => {
        const order = loadFixture("gpsUsOrder");
        expect(calculateTaxAmount(order)).toBe(10.0);
      });

      it("returns 0 for zero-tax orders", () => {
        const order = loadFixture("hkOrder");
        expect(calculateTaxAmount(order)).toBe(0);
      });
    });

    describe("calculateDutyAmount", () => {
      it("returns 0 when no duties present", () => {
        const order = loadFixture("gpsUsOrder");
        expect(calculateDutyAmount(order)).toBe(0);
      });

      it("returns duty amount from shop_money", () => {
        const order = loadFixture("gpsUsOrder") as any;
        order.current_total_duties_set = {
          shop_money: { amount: "5.50", currency_code: "USD" },
        };
        expect(calculateDutyAmount(order)).toBe(5.5);
      });
    });

    describe("calculatePrepaymentAmount", () => {
      it("returns total_price", () => {
        const order = loadFixture("gpsUsOrder");
        expect(calculatePrepaymentAmount(order)).toBe(129.99);
      });
    });

    describe("calculateOrderCost", () => {
      it("calculates total from lines with discounts", () => {
        const lines = [
          { price: 100, discount: 10, quantity: 2 },
          { price: 50, quantity: 1 },
        ];
        expect(calculateOrderCost(lines)).toBe(230); // (100-10)*2 + 50*1
      });
    });
  });

  describe("Routing Helpers", () => {
    describe("shouldSendToGps", () => {
      it("returns true for GPS warehouse", () => {
        const order = loadFixture("gpsUsOrder");
        expect(shouldSendToGps(order, "GPS Warehouse")).toBe(true);
      });

      it("returns true for GPS UK warehouse", () => {
        const order = loadFixture("gpsUkOrder");
        expect(shouldSendToGps(order, "GPS UK Warehouse")).toBe(true);
      });

      it("returns false for STORD warehouse", () => {
        const order = loadFixture("stordOrder");
        expect(shouldSendToGps(order, "STORD ATL Location")).toBe(false);
      });

      it("returns false for HK warehouse", () => {
        const order = loadFixture("hkOrder");
        expect(shouldSendToGps(order, "HK Warehouse")).toBe(false);
      });
    });

    describe("isTestOrder", () => {
      it("returns true for testing-tagged orders", () => {
        const order = loadFixture("gpsUsOrder");
        order.tags = "testing";
        expect(isTestOrder(order)).toBe(true);
      });

      it("returns true for load-testing tag", () => {
        const order = loadFixture("gpsUsOrder");
        order.tags = "load-testing, other";
        expect(isTestOrder(order)).toBe(true);
      });

      it("returns false for normal orders", () => {
        const order = loadFixture("gpsUsOrder");
        expect(isTestOrder(order)).toBe(false);
      });
    });

    describe("isOrderTaggedWith", () => {
      it("detects tag in comma-separated list", () => {
        expect(isOrderTaggedWith({ tags: "sub, testing, vip" }, "testing")).toBe(true);
      });

      it("returns false when tag not present", () => {
        expect(isOrderTaggedWith({ tags: "sub, vip" }, "testing")).toBe(false);
      });

      it("handles empty tags", () => {
        expect(isOrderTaggedWith({ tags: "" }, "testing")).toBe(false);
      });
    });
  });
});
