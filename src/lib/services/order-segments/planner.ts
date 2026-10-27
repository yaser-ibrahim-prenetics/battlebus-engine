import type { ShopifyOrderPayload } from "@/inngest/events";
import type { IShopifyFulfillmentOrder } from "@/lib/types/shopify";
import { fingerprint } from "../fulfillment-actions/identity";
import type { OrderSegment, SegmentPlan } from "./types";

type Routing = Pick<OrderSegment, "warehouse" | "dataAreaId">;

export function orderInputHash(order: ShopifyOrderPayload) {
  return fingerprint({
    lines: order.line_items.map((line) => ({
      id: line.id,
      sku: line.sku,
      quantity: line.quantity,
      price: line.price,
      total_discount: line.total_discount,
      gift_card: line.gift_card,
      requires_shipping: line.requires_shipping,
    })),
    currency: order.currency,
    shipping: order.shipping_lines,
    tax: order.total_tax,
    duties: (order as ShopifyOrderPayload & { current_total_duties_set?: unknown })
      .current_total_duties_set,
    discounts: order.discount_codes,
    address: order.shipping_address,
    billing: order.billing_address,
  });
}

/** Split quantities, not array positions. One oversized unit is never divided. */
export function planOrderSegments(
  order: ShopifyOrderPayload,
  fulfillmentOrders: IShopifyFulfillmentOrder[],
  threshold: number,
  routingByLocation: Record<string, Routing>
): SegmentPlan {
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Invalid split threshold");
  const physical = order.line_items.filter((line) => line.requires_shipping && !line.gift_card);
  const byId = new Map(physical.map((line) => [String(line.id), line]));
  const quantities = new Map<string, number>();
  const segments: OrderSegment[] = [];
  const limit = threshold > 0 ? Math.round(threshold * 100) : Infinity;
  for (const fo of [...fulfillmentOrders].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  )) {
    if (!["open", "in_progress"].includes(fo.status)) continue;
    const lines = fo.line_items.filter((line) => byId.has(String(line.line_item_id)));
    if (!lines.length) continue;
    const routing = routingByLocation[String(fo.assigned_location_id)];
    if (!routing)
      throw new Error(`Missing segment routing for location ${fo.assigned_location_id}`);
    let segment: OrderSegment | undefined;
    let value = 0;
    for (const source of lines) {
      const line = byId.get(String(source.line_item_id))!;
      const quantity = source.fulfillable_quantity;
      const unit = Math.round(Number(line.price) * 100);
      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        !Number.isSafeInteger(unit) ||
        unit < 0
      )
        throw new Error("Invalid fulfillment quantity or price");
      quantities.set(String(line.id), (quantities.get(String(line.id)) ?? 0) + quantity);
      for (let count = 0; count < quantity; count++) {
        if (!segment || (value > 0 && value + unit > limit)) {
          if (segments.length >= 100) throw new Error("Order exceeds the 100-segment safety limit");
          segment = {
            index: segments.length,
            sourceFulfillmentOrderId: String(fo.id),
            locationId: String(fo.assigned_location_id),
            ...routing,
            lines: [],
          };
          segments.push(segment);
          value = 0;
        }
        const selected = segment.lines.find((item) => item.lineItemId === String(line.id));
        if (selected) selected.quantity++;
        else segment.lines.push({ lineItemId: String(line.id), quantity: 1, physical: true });
        value += unit;
      }
    }
  }
  // A new plan must represent the entire physical order. Partial historical orders
  // require reconciliation; silently treating their remainder as a new order duplicates finance.
  for (const line of physical) {
    if (quantities.get(String(line.id)) !== line.quantity)
      throw new Error(`Fulfillment quantities do not cover order line ${line.id}`);
  }
  if (segments.length) {
    segments[0].lines.push(
      ...order.line_items
        .filter((line) => !byId.has(String(line.id)))
        .map((line) => ({ lineItemId: String(line.id), quantity: line.quantity, physical: false }))
    );
  }
  return {
    version: 1,
    orderId: String(order.id),
    orderName: order.name,
    inputHash: orderInputHash(order),
    segments,
  };
}

/** Keep source line IDs; allocate discount cents exactly, and charge freight/tax once. */
export function segmentOrder(
  order: ShopifyOrderPayload,
  plan: SegmentPlan,
  index: number
): ShopifyOrderPayload {
  const segment = plan.segments[index];
  if (!segment) throw new Error(`Unknown segment ${index}`);
  const line_items = segment.lines.map((selected) => {
    const line = order.line_items.find((line) => String(line.id) === selected.lineItemId);
    if (!line) throw new Error(`Missing source line ${selected.lineItemId}`);
    const previous = plan.segments
      .slice(0, index)
      .reduce(
        (sum, part) =>
          sum + (part.lines.find((item) => item.lineItemId === selected.lineItemId)?.quantity ?? 0),
        0
      );
    const cents = Math.round(Number(line.total_discount || 0) * 100);
    const allocated =
      Math.round((cents * (previous + selected.quantity)) / line.quantity) -
      Math.round((cents * previous) / line.quantity);
    return { ...line, quantity: selected.quantity, total_discount: (allocated / 100).toFixed(2) };
  });
  return {
    ...order,
    line_items,
    ...(index === 0
      ? {}
      : { shipping_lines: [], tax_lines: [], total_tax: "0", current_total_duties_set: null }),
  };
}
