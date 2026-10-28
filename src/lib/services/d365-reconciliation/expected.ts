import type { ShopifyOrderPayload } from "@/inngest/events";
import { searchOrdersByName, getOrder, getFulfillmentOrders } from "@/lib/clients/shopify";
import { config } from "@/lib/config";
import { determineWarehouse, getWarehouseConfig } from "@/lib/helpers/warehouse";
import { planOrderSegments, segmentOrder } from "../order-segments/planner";
import { resolveSegmentRouting } from "../order-segments/routing";
import { fulfillmentOrderIds } from "../order-segments/shopify";
import { allocateQuantities, type Allocation } from "../order-segments/allocation";
import { segmentLineRequests } from "../order-segments/lines";
import { loadOrderAccounting } from "../order-accounting/load";
import type { OrderSegment, SegmentPlan, StoredPlan } from "../order-segments/types";
import { inWindow } from "./window";
import type { Kind, Window } from "./types";
import type { FinancialLine } from "./financial-comparison";

/** Rebuild expected routing and amounts from Shopify, not Battle Bus order rows. */
export async function expectedOrderEvidence(
  name: string,
  kind: Kind,
  window: Window
): Promise<FinancialLine[]> {
  const shop = config.shopify.im8.shopDomain;
  const matches = (await searchOrdersByName(name, shop)).filter((order) => order.name === name);
  if (matches.length !== 1) throw new Error("Shopify reference did not resolve uniquely");
  const order = (await getOrder(matches[0].id, shop)) as ShopifyOrderPayload;
  const fos = (await getFulfillmentOrders(order.id, shop)).filter(
    (fo) => fo.status !== "cancelled"
  );
  const country =
    order.shipping_address?.country_code || order.billing_address?.country_code || "US";
  const routing: Record<string, Pick<OrderSegment, "warehouse" | "dataAreaId">> = {};
  for (const fo of fos)
    routing[String(fo.assigned_location_id)] = await resolveSegmentRouting(order, fo, country);
  const hasPhysical = order.line_items.some((line) => line.requires_shipping && !line.gift_card);
  const warehouse = determineWarehouse(country);
  const plan: SegmentPlan = hasPhysical
    ? planOrderSegments(
        order,
        fos.map((fo) => ({
          ...fo,
          status: "open",
          line_items: fo.line_items.map((line) => ({
            ...line,
            fulfillable_quantity: line.quantity,
          })),
        })),
        0,
        routing
      )
    : {
        version: 1,
        orderId: String(order.id),
        orderName: order.name,
        inputHash: "provider-evidence",
        segments: [
          {
            index: 0,
            sourceFulfillmentOrderId: "virtual",
            locationId: "virtual",
            warehouse,
            dataAreaId: getWarehouseConfig(warehouse).dataAreaId,
            lines: order.line_items.map((line) => ({
              lineItemId: String(line.id),
              quantity: line.quantity,
              physical: false,
            })),
          },
        ],
      };
  const accounting = await loadOrderAccounting(order, shop);
  const requests = plan.segments.map((segment) =>
    segmentLineRequests(segmentOrder(order, plan, segment.index), segment, "evidence", accounting)
  );
  const output: FinancialLine[] = [];
  if (kind === "salesorder") {
    for (const [index, lines] of requests.entries())
      for (const { request } of lines)
        output.push({
          company: plan.segments[index].dataAreaId.toUpperCase(),
          item: request.itemNumber,
          currency: request.currency || "USD",
          quantity: request.quantity,
          amountCents: Math.round(
            (request.price - (request.discount ?? 0)) * request.quantity * 100
          ),
        });
    return output;
  }
  const stored: StoredPlan = {
    plan,
    progress: Object.fromEntries(
      plan.segments.map((segment) => [
        String(segment.index),
        { fulfillmentOrderId: segment.sourceFulfillmentOrderId },
      ])
    ),
  };
  const previous: Allocation[] = [];
  for (const fulfillment of [...(order.fulfillments ?? [])]
    .filter((f) => f.status === "success")
    .sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || String(a.id).localeCompare(String(b.id))
    )) {
    const ids = await fulfillmentOrderIds(shop, fulfillment.id);
    const quantities: Record<string, number> = {};
    for (const line of fulfillment.line_items)
      if (
        plan.segments.some((s) =>
          s.lines.some((l) => l.physical && l.lineItemId === String(line.id))
        )
      )
        quantities[String(line.id)] = (quantities[String(line.id)] ?? 0) + line.quantity;
    if (!Object.keys(quantities).length) continue;
    const allocations = allocateQuantities(
      stored,
      String(fulfillment.id),
      ids,
      quantities,
      previous,
      "provider-evidence",
      fulfillment.created_at
    );
    previous.push(...allocations);
    if (!inWindow(fulfillment.created_at, window)) continue;
    for (const allocation of allocations)
      for (const line of requests[allocation.segment_index]) {
        const sourceQuantity = allocation.quantities[line.sourceLineId] ?? 0;
        if (line.isService ? !allocation.include_services : !sourceQuantity) continue;
        output.push({
          company: plan.segments[allocation.segment_index].dataAreaId.toUpperCase(),
          item: line.request.itemNumber,
          currency: "QUANTITY",
          quantity: line.isService
            ? line.request.quantity
            : (line.request.quantity * sourceQuantity) / line.sourceQuantity,
          amountCents: 0,
        });
      }
  }
  if (!output.length)
    throw new Error("Shopify fulfillment event has no complete line evidence in the window");
  return output;
}
