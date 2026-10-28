import type { ShopifyOrderPayload } from "@/inngest/events";
import type { OrderAccounting } from "../order-accounting/types";
import type { OrderSegment } from "./types";
import {
  toD365SalesOrderLines,
  toD365SubscriptionRewardLines,
} from "@/lib/transformers/order";
import { subscriptionRewardSegmentLineItemId } from "@/lib/helpers/subscription-rewards";

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
      accounting,
      false
    ).map((request) => ({
      sourceLineId: String(line.id),
      sourceQuantity: line.quantity,
      isService: Boolean(line.gift_card || !line.requires_shipping),
      isSubscriptionReward: false,
      request,
    }))
  );
  const serviceLines = toD365SalesOrderLines(
    { ...order, line_items: [] },
    salesOrderNumber,
    segment.warehouse,
    true,
    segment.dataAreaId,
    accounting,
    false
  ).map((request, index) => ({
    sourceLineId: `service:${index}`,
    sourceQuantity: 1,
    isService: true,
    isSubscriptionReward: false,
    request,
  }));
  const rewardLines = toD365SubscriptionRewardLines(
    order,
    salesOrderNumber,
    segment.warehouse,
    segment.dataAreaId
  ).map((request) => ({
    sourceLineId: subscriptionRewardSegmentLineItemId(request.itemNumber, segment.index),
    sourceQuantity: request.quantity,
    isService: true,
    isSubscriptionReward: true,
    request,
  }));
  return [...productLines, ...serviceLines, ...rewardLines];
}
