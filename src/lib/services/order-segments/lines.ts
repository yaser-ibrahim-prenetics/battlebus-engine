import type { ShopifyOrderPayload } from "@/inngest/events";
import type { OrderAccounting } from "../order-accounting/types";
import type { OrderSegment } from "./types";
import { toD365SalesOrderLines } from "@/lib/transformers/order";

/** Preserve the source line identity even when bundles expand to several D365 lines. */
export function segmentLineRequests(
  order: ShopifyOrderPayload,
  segment: OrderSegment,
  salesOrderNumber: string,
  accounting: OrderAccounting
) {
  const productLines = order.line_items.flatMap((line) =>
    toD365SalesOrderLines(
      { ...order, line_items: [line] },
      salesOrderNumber,
      segment.warehouse,
      false,
      segment.dataAreaId,
      accounting
    ).map((request) => ({
      sourceLineId: String(line.id),
      sourceQuantity: line.quantity,
      isService: Boolean(line.gift_card || !line.requires_shipping),
      request,
    }))
  );
  const serviceLines = toD365SalesOrderLines(
    { ...order, line_items: [] },
    salesOrderNumber,
    segment.warehouse,
    true,
    segment.dataAreaId,
    accounting
  ).map((request, index) => ({
    sourceLineId: `service:${index}`,
    sourceQuantity: 1,
    isService: true,
    request,
  }));
  return [...productLines, ...serviceLines];
}
