import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../../tests/fixtures";
import type { IShopifyFulfillmentOrder } from "@/lib/types/shopify";
import { planOrderSegments, segmentOrder } from "../planner";
import {
  toD365SalesOrderLines,
  calculateOrderCost,
  toGpsOutboundOrder,
} from "@/lib/transformers/order";

function fixture() {
  const order = loadFixture("multiLineOrder");
  order.line_items = [
    {
      ...order.line_items[0],
      id: 11,
      requires_shipping: true,
      gift_card: false,
      price: "100.00",
      quantity: 5,
      total_discount: "0.01",
    },
  ];
  const fos = [
    {
      id: 51,
      assigned_location_id: 71,
      status: "open",
      line_items: [{ id: 81, line_item_id: 11, quantity: 5, fulfillable_quantity: 5 }],
    },
  ] as IShopifyFulfillmentOrder[];
  const routing = { "71": { warehouse: "GPS Warehouse" as const, dataAreaId: "H007" } };
  return { order, fos, routing };
}

describe("quantity-based segment planning", () => {
  it("retains associated-order metadata for every segmented Hub snapshot", () => {
    const { order, fos, routing } = fixture();
    order.tags = "replacement-im8-1234";

    expect(planOrderSegments(order, fos, 250, routing).associatedOrder).toEqual({
      orderName: "IM8-1234",
      relationship: "replacement",
    });
  });

  it("splits a single SKU's quantity and conserves every unit and discount cent", () => {
    const { order, fos, routing } = fixture();
    const plan = planOrderSegments(order, fos, 250, routing);
    expect(plan.segments.map((s) => s.lines[0].quantity)).toEqual([2, 2, 1]);
    const orders = plan.segments.map((s) => segmentOrder(order, plan, s.index));
    expect(orders.map((o) => o.line_items[0].total_discount)).toEqual(["0.00", "0.01", "0.00"]);
    const cost = (o: typeof order) =>
      calculateOrderCost(toD365SalesOrderLines(o, "SO", "GPS Warehouse", true, "H007"));
    expect(orders.reduce((sum, o) => sum + cost(o), 0)).toBeCloseTo(cost(order), 2);
    expect(orders.slice(1).every((o) => o.shipping_lines.length === 0 && o.total_tax === "0")).toBe(
      true
    );
    expect(
      orders.map((o, i) =>
        toGpsOutboundOrder(o, `SO${i}`, "GPS Warehouse").productList.reduce(
          (sum, line) => sum + line.quantity,
          0
        )
      )
    ).toEqual([2, 2, 1]);
  });
  it("keeps separate fulfillment locations even below the threshold", () => {
    const { order, fos, routing } = fixture();
    fos[0].line_items[0].fulfillable_quantity = 2;
    const second = {
      ...fos[0],
      id: 52,
      line_items: [{ ...fos[0].line_items[0], fulfillable_quantity: 3 }],
    };
    expect(planOrderSegments(order, [...fos, second], 0, routing).segments).toHaveLength(2);
  });
  it("rejects incomplete or duplicate source quantities before any provider writes", () => {
    const { order, fos, routing } = fixture();
    fos[0].line_items[0].fulfillable_quantity = 4;
    expect(() => planOrderSegments(order, fos, 250, routing)).toThrow("do not cover");
    fos[0].line_items[0].fulfillable_quantity = 6;
    expect(() => planOrderSegments(order, fos, 250, routing)).toThrow("do not cover");
  });
  it("keeps gift-card accounting on the first segment and never puts it in GPS", () => {
    const { order, fos, routing } = fixture();
    order.line_items.push({
      ...order.line_items[0],
      id: 22,
      gift_card: true,
      requires_shipping: false,
      quantity: 1,
    });
    const plan = planOrderSegments(order, fos, 250, routing);
    expect(plan.segments.map((s) => s.lines.some((l) => l.lineItemId === "22"))).toEqual([
      true,
      false,
      false,
    ]);
  });
});
