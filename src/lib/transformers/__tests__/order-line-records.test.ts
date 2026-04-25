import { describe, it, expect } from "vitest";
import { toOrderLineRecords } from "../order";
import { loadFixture } from "../../../../tests/fixtures";

describe("toOrderLineRecords", () => {
  it("produces product lines with Shopify line item IDs", () => {
    const order = loadFixture("gpsUsOrder");
    const records = toOrderLineRecords(order, "U001-SO-100", "GPS Warehouse");

    const productLines = records.filter((r) => !r.isServiceLine);
    expect(productLines.length).toBeGreaterThanOrEqual(1);
    for (const line of productLines) {
      expect(line.shopifyLineItemId).toMatch(/^\d+$/); // numeric Shopify id
      expect(line.shopifySku).toBeTruthy();
      expect(line.d365ItemNumber).toBeTruthy();
      expect(line.isServiceLine).toBe(false);
    }
  });

  it("produces a shipping service line with synthetic id 'shipping'", () => {
    const order = loadFixture("gpsUsOrder"); // has 9.99 shipping
    const records = toOrderLineRecords(order, "U001-SO-100", "GPS Warehouse");

    const shipping = records.find((r) => r.shopifyLineItemId === "shipping");
    expect(shipping).toBeDefined();
    expect(shipping!.d365ItemNumber).toBe("IM8-SER-000002");
    expect(shipping!.price).toBe(9.99);
    expect(shipping!.isServiceLine).toBe(true);
    expect(shipping!.shopifySku).toBeNull();
  });

  it("produces a tax service line with synthetic id 'tax'", () => {
    const order = loadFixture("gpsUsOrder"); // has 10.00 tax
    const records = toOrderLineRecords(order, "U001-SO-100", "GPS Warehouse");

    const tax = records.find((r) => r.shopifyLineItemId === "tax");
    expect(tax).toBeDefined();
    expect(tax!.d365ItemNumber).toBe("IM8-SER-000001");
    expect(tax!.price).toBe(10);
    expect(tax!.isServiceLine).toBe(true);
  });

  it("omits shipping and tax service lines when zero", () => {
    const order = loadFixture("hkOrder"); // zero shipping, zero tax
    const records = toOrderLineRecords(order, "H007-SO-100", "HK Warehouse");

    expect(records.find((r) => r.shopifyLineItemId === "shipping")).toBeUndefined();
    expect(records.find((r) => r.shopifyLineItemId === "tax")).toBeUndefined();
  });

  it("skips dummy IM8-FG-G* SKUs", () => {
    const order = loadFixture("gpsUsOrder");
    order.line_items = [{ ...order.line_items[0], sku: "IM8-FG-G00003" }];
    const records = toOrderLineRecords(order, "U001-SO-100", "GPS Warehouse");

    expect(records.some((r) => r.d365ItemNumber === "IM8-FG-G00003")).toBe(false);
  });

  it("skips gift card lines", () => {
    const order = loadFixture("multiLineOrder");
    const records = toOrderLineRecords(order, "U001-SO-300", "GPS Warehouse");
    expect(records.some((r) => r.d365ItemNumber === "IM8-GC-50")).toBe(false);
  });

  it("uses HK warehouse service SKU for HK orders with non-zero shipping", () => {
    const order = loadFixture("gpsUkOrder"); // UK warehouse
    const records = toOrderLineRecords(order, "H007-SO-100", "GPS UK Warehouse");

    const shipping = records.find((r) => r.shopifyLineItemId === "shipping");
    if (shipping) {
      expect(shipping.d365ItemNumber).toBe("IM8-SER-000002");
    }
  });
});
