import { shopifyAdminGraphql } from "@/lib/clients/shopify";
import { ORDER_ACCOUNTING_API_VERSION } from "@/lib/graphql/order-accounting";
import {
  fulfillmentOrderForSplitQuery,
  splitFulfillmentOrderMutation,
  fulfillmentSegmentsQuery,
} from "@/lib/graphql/order-segments";
import { executeFulfillmentAction, ConfirmedActionFailure } from "../fulfillment-actions/ledger";
import { saveProgress } from "./store";
import type { SegmentLine, SegmentPlan } from "./types";

interface FulfillmentOrder {
  id: string;
  lineItems: {
    nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[];
    pageInfo: { hasNextPage: boolean };
  };
}
const numericId = (id: string) => id.split("/").pop()!;
const options = (shop: string) => ({ apiVersion: ORDER_ACCOUNTING_API_VERSION, shopDomain: shop });
function assertComplete(fo: FulfillmentOrder | undefined | null): asserts fo is FulfillmentOrder {
  if (
    !fo?.id ||
    !Array.isArray(fo.lineItems?.nodes) ||
    fo.lineItems.pageInfo?.hasNextPage !== false
  )
    throw new Error("Shopify fulfillment order response is missing or truncated");
}
function matches(fo: FulfillmentOrder, selected: SegmentLine[]) {
  const remaining = fo.lineItems.nodes.filter((line) => line.remainingQuantity > 0);
  return (
    remaining.length === selected.length &&
    selected.every((line) =>
      remaining.some(
        (candidate) =>
          numericId(candidate.lineItem.id) === line.lineItemId &&
          candidate.remainingQuantity === line.quantity
      )
    )
  );
}

/** Bind every planned segment to a real Shopify FO before any D365/GPS write. */
export async function bindShopifySegments(shop: string, plan: SegmentPlan) {
  const binding: Record<number, string> = {};
  const sources = [...new Set(plan.segments.map((s) => s.sourceFulfillmentOrderId))];
  for (const sourceId of sources) {
    const segments = plan.segments.filter((s) => s.sourceFulfillmentOrderId === sourceId);
    let remainderId = sourceId;
    for (const segment of segments.slice(0, -1)) {
      const result = await executeFulfillmentAction(
        {
          provider: "shopify",
          scope: shop,
          sourceOrderId: plan.orderId,
          sourceLineIds: [`split:${segment.index}`],
          action: `split:${segment.index}`,
        },
        { planHash: plan.inputHash, sourceId, index: segment.index, lines: segment.lines },
        async () => {
          const read = await shopifyAdminGraphql<{
            data?: { fulfillmentOrder?: FulfillmentOrder };
          }>(
            fulfillmentOrderForSplitQuery,
            { id: `gid://shopify/FulfillmentOrder/${remainderId}` },
            options(shop)
          );
          const current = read.data?.fulfillmentOrder;
          assertComplete(current);
          const selected = segment.lines.filter((line) => line.physical);
          const expectedRemaining = new Map<string, number>();
          for (const part of segments.filter((part) => part.index >= segment.index)) {
            for (const line of part.lines.filter((line) => line.physical))
              expectedRemaining.set(
                line.lineItemId,
                (expectedRemaining.get(line.lineItemId) ?? 0) + line.quantity
              );
          }
          if (
            !matches(
              current,
              [...expectedRemaining].map(([lineItemId, quantity]) => ({
                lineItemId,
                quantity,
                physical: true,
              }))
            )
          )
            throw new ConfirmedActionFailure(
              "Shopify fulfillment quantities changed before splitting"
            );
          const fulfillmentOrderLineItems = selected.map((line) => {
            const item = current.lineItems.nodes.find(
              (item) => numericId(item.lineItem.id) === line.lineItemId
            )!;
            if (item.remainingQuantity < line.quantity)
              throw new Error("Shopify quantities changed after planning");
            return { id: item.id, quantity: line.quantity };
          });
          if (!fulfillmentOrderLineItems.length) throw new Error("No physical lines to split");
          const response = await shopifyAdminGraphql<{
            data?: {
              fulfillmentOrderSplit?: {
                userErrors: { message: string }[];
                fulfillmentOrderSplits: {
                  fulfillmentOrder: FulfillmentOrder;
                  remainingFulfillmentOrder: FulfillmentOrder;
                }[];
              };
            };
          }>(
            splitFulfillmentOrderMutation,
            { splits: [{ fulfillmentOrderId: current.id, fulfillmentOrderLineItems }] },
            options(shop)
          );
          const payload = response.data?.fulfillmentOrderSplit;
          if (payload?.userErrors?.length)
            throw new ConfirmedActionFailure("Shopify rejected fulfillment split");
          if (payload?.fulfillmentOrderSplits?.length !== 1)
            throw new Error("Shopify split result missing");
          const { fulfillmentOrder: left, remainingFulfillmentOrder: right } =
            payload.fulfillmentOrderSplits[0];
          assertComplete(left);
          assertComplete(right);
          if (left.id === right.id) throw new Error("Shopify split did not produce two orders");
          const chosen = matches(left, selected) ? left : matches(right, selected) ? right : null;
          if (!chosen) throw new Error("Shopify split quantities do not match the plan");
          return {
            selectedId: numericId(chosen.id),
            remainderId: numericId(chosen === left ? right.id : left.id),
          };
        }
      );
      binding[segment.index] = result.selectedId;
      await saveProgress(shop, plan.orderId, segment.index, {
        fulfillmentOrderId: result.selectedId,
      });
      remainderId = result.remainderId;
    }
    const last = segments[segments.length - 1];
    binding[last.index] = remainderId;
    await saveProgress(shop, plan.orderId, last.index, { fulfillmentOrderId: remainderId });
  }
  return binding;
}

export async function fulfillmentOrderIds(shop: string, fulfillmentId: string | number) {
  const response = await shopifyAdminGraphql<{
    data?: {
      fulfillment?: {
        fulfillmentOrders?: {
          nodes: { id: string }[];
          pageInfo: { hasNextPage: boolean };
        };
      };
    };
  }>(fulfillmentSegmentsQuery, { id: `gid://shopify/Fulfillment/${fulfillmentId}` }, options(shop));
  const orders = response.data?.fulfillment?.fulfillmentOrders;
  if (!orders?.nodes?.length || orders.pageInfo?.hasNextPage !== false)
    throw new Error("Fulfillment segment association missing or truncated");
  return orders.nodes.map((fo) => numericId(fo.id));
}
