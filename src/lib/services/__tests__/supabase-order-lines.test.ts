import { describe, it, expect } from "vitest";
import {
  SHOPIFY_SHIPPING_LINE_ITEM_ID,
  SHOPIFY_TAX_LINE_ITEM_ID,
  buildRefundLineItemId,
  buildLotIdMapFromOrderLines,
  getLotFromSavedOrderLineByShopifyLineItemId,
  filterUnfulfilledServiceLines,
  type SavedOrderLine,
} from "../supabase-order-lines";

describe("supabase-order-lines (unit)", () => {
  const baseProductLine: SavedOrderLine = {
    id: "pid1",
    shopify_order_id: "1001",
    shopify_order_name: "IM8-100",
    shopify_line_item_id: "14001",
    shopify_sku: "IM8-FG-000031",
    d365_item_number: "IM8-FG-000048",
    d365_sales_order_number: "U001-SO-100",
    data_area_id: "U001",
    quantity: 1,
    price: 49.99,
    dynamics_inventory_lot_id: "LOT001",
    is_service_line: false,
    is_fulfilled_to_dynamics: false,
    fulfilled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const shippingLine: SavedOrderLine = {
    ...baseProductLine,
    id: "sid1",
    shopify_line_item_id: SHOPIFY_SHIPPING_LINE_ITEM_ID,
    shopify_sku: null,
    d365_item_number: "IM8-SER-000002",
    quantity: 1,
    price: 9.99,
    dynamics_inventory_lot_id: "LOT-SHIP",
    is_service_line: true,
    is_fulfilled_to_dynamics: false,
  };

  const taxLine: SavedOrderLine = {
    ...baseProductLine,
    id: "tid1",
    shopify_line_item_id: SHOPIFY_TAX_LINE_ITEM_ID,
    shopify_sku: null,
    d365_item_number: "IM8-SER-000001",
    quantity: 1,
    price: 10.0,
    dynamics_inventory_lot_id: "LOT-TAX",
    is_service_line: true,
    is_fulfilled_to_dynamics: false,
  };

  it("returns service lines that are not yet fulfilled", () => {
    const lines = [baseProductLine, shippingLine, taxLine];
    const result = filterUnfulfilledServiceLines(lines);
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.shopify_line_item_id)).toContain(SHOPIFY_SHIPPING_LINE_ITEM_ID);
    expect(result.map((l) => l.shopify_line_item_id)).toContain(SHOPIFY_TAX_LINE_ITEM_ID);
  });

  it("returns empty when all service lines are already fulfilled", () => {
    const lines = [
      baseProductLine,
      { ...shippingLine, is_fulfilled_to_dynamics: true },
      { ...taxLine, is_fulfilled_to_dynamics: true },
    ];
    expect(filterUnfulfilledServiceLines(lines)).toHaveLength(0);
  });

  it("returns empty when there are no service lines at all", () => {
    expect(filterUnfulfilledServiceLines([baseProductLine])).toHaveLength(0);
  });

  it("only returns unfulfilled service lines (not already-fulfilled ones)", () => {
    const lines = [{ ...shippingLine, is_fulfilled_to_dynamics: true }, taxLine];
    const result = filterUnfulfilledServiceLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].shopify_line_item_id).toBe(SHOPIFY_TAX_LINE_ITEM_ID);
  });

  it("SHOPIFY_SHIPPING_LINE_ITEM_ID is 'shipping'", () => {
    expect(SHOPIFY_SHIPPING_LINE_ITEM_ID).toBe("shipping");
  });

  it("SHOPIFY_TAX_LINE_ITEM_ID is 'tax'", () => {
    expect(SHOPIFY_TAX_LINE_ITEM_ID).toBe("tax");
  });

  it("buildLotIdMapFromOrderLines maps d365 item to lot", () => {
    const lines: SavedOrderLine[] = [
      { ...baseProductLine, dynamics_inventory_lot_id: "LOT-A" },
      { ...shippingLine, dynamics_inventory_lot_id: "LOT-S" },
    ];
    const m = buildLotIdMapFromOrderLines(lines);
    expect(m["IM8-FG-000048"]).toBe("LOT-A");
    expect(m["IM8-SER-000002"]).toBe("LOT-S");
  });

  it("getLotFromSavedOrderLineByShopifyLineItemId returns lot for line item id", () => {
    const lines: SavedOrderLine[] = [{ ...baseProductLine, dynamics_inventory_lot_id: "LOT-Z" }];
    expect(getLotFromSavedOrderLineByShopifyLineItemId(lines, "14001")).toBe("LOT-Z");
    expect(getLotFromSavedOrderLineByShopifyLineItemId(lines, "999")).toBe("");
  });

  it("detects service line by IM8-SER- SKU even when is_service_line is false", () => {
    const serOnly: SavedOrderLine = {
      ...shippingLine,
      is_service_line: false,
    };
    expect(filterUnfulfilledServiceLines([serOnly])).toHaveLength(1);
  });

  it("excludes synthetic refund order_lines from unfulfilled service picks", () => {
    const refundLine: SavedOrderLine = {
      ...shippingLine,
      id: "rid1",
      shopify_line_item_id: buildRefundLineItemId("987422032039"),
      d365_item_number: "IM8-SER-REFUND",
      is_service_line: true,
      is_fulfilled_to_dynamics: false,
    };
    const lines = [shippingLine, taxLine, refundLine];
    const result = filterUnfulfilledServiceLines(lines);
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.shopify_line_item_id)).not.toContain(refundLine.shopify_line_item_id);
  });
});
