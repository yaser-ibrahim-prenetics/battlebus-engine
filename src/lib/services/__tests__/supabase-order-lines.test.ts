import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SHOPIFY_SHIPPING_LINE_ITEM_ID,
  SHOPIFY_TAX_LINE_ITEM_ID,
  type SavedOrderLine,
} from "../supabase-order-lines";

// ============================================================================
// fetchUnfulfilledServiceLines (pure logic extracted for unit test)
// ============================================================================

function applyUnfulfilledServiceFilter(lines: SavedOrderLine[]): SavedOrderLine[] {
  return lines.filter((l) => l.is_service_line && !l.is_fulfilled_to_dynamics);
}

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
    d365_item_number: "IM8-SER-000004",
    quantity: 1,
    price: 10.0,
    dynamics_inventory_lot_id: "LOT-TAX",
    is_service_line: true,
    is_fulfilled_to_dynamics: false,
  };

  it("returns service lines that are not yet fulfilled", () => {
    const lines = [baseProductLine, shippingLine, taxLine];
    const result = applyUnfulfilledServiceFilter(lines);
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
    expect(applyUnfulfilledServiceFilter(lines)).toHaveLength(0);
  });

  it("returns empty when there are no service lines at all", () => {
    expect(applyUnfulfilledServiceFilter([baseProductLine])).toHaveLength(0);
  });

  it("only returns unfulfilled service lines (not already-fulfilled ones)", () => {
    const lines = [
      { ...shippingLine, is_fulfilled_to_dynamics: true },
      taxLine,
    ];
    const result = applyUnfulfilledServiceFilter(lines);
    expect(result).toHaveLength(1);
    expect(result[0].shopify_line_item_id).toBe(SHOPIFY_TAX_LINE_ITEM_ID);
  });

  it("SHOPIFY_SHIPPING_LINE_ITEM_ID is 'shipping'", () => {
    expect(SHOPIFY_SHIPPING_LINE_ITEM_ID).toBe("shipping");
  });

  it("SHOPIFY_TAX_LINE_ITEM_ID is 'tax'", () => {
    expect(SHOPIFY_TAX_LINE_ITEM_ID).toBe("tax");
  });
});
