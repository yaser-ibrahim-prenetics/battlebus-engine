import * as slack from "@/lib/clients/slack";
import { getFulfillmentOrders, shopifyAdminGraphql } from "@/lib/clients/shopify";
import {
  buildFulfillmentSegments,
  isDomesticOrder,
  shouldSplitFulfillmentOrder,
  toShopifyFulfillmentOrderSplits,
} from "@/lib/helpers/split";
import { SlackChannelEnum } from "@/lib/types/slack";
import type { ShopifyOrderPayload } from "../../events";
import type { PublishStatus, StepTools } from "./types";

export type FulfillmentSplitResult = {
  applied: boolean;
  reason: string;
  threshold: number | null;
  error?: string;
  fulfillmentOrders: Array<{
    sourceFulfillmentOrderId: string;
    segments: ReturnType<typeof buildFulfillmentSegments>;
    resultingFulfillmentOrderIds: string[];
  }>;
};

export async function splitShopifyFulfillmentOrder({
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  destinationCountryCode,
  publishStatus,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  destinationCountryCode: string;
  publishStatus: PublishStatus;
}): Promise<FulfillmentSplitResult> {
  await publishStatus("send-to-gps", "running", "Preparing GPS warehouse order");
  return step.run("shopify-fulfillment-order-split", async () => {
    try {
      const orderTotal = parseFloat(order.total_price || "0");
      const countryCode = destinationCountryCode || "US";
      const domestic = isDomesticOrder(countryCode);
      const splitDecision = shouldSplitFulfillmentOrder(orderTotal, countryCode, domestic);

      console.log(
        `[Fulfillment Split] ${shopifyOrderName}: ${splitDecision.reason} ` +
          `(total=${orderTotal}, threshold=${splitDecision.threshold}, country=${countryCode})`
      );

      if (!splitDecision.shouldSplit) {
        return {
          applied: false as const,
          reason: splitDecision.reason,
          threshold: splitDecision.threshold,
          fulfillmentOrders: [],
        };
      }

      const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
      const openFulfillmentOrders = (fulfillmentOrders || []).filter(
        (fo: any) => fo?.status === "open" || fo?.status === "in_progress"
      );
      if (openFulfillmentOrders.length === 0) {
        console.warn(`[Fulfillment Split] No open fulfillment order found for ${shopifyOrderName}`);
        return {
          applied: false as const,
          reason: "no_open_fulfillment_order",
          threshold: splitDecision.threshold,
          fulfillmentOrders: [],
        };
      }

      const mutation = `
      mutation fulfillmentOrderSplit($fulfillmentOrderId: ID!, $fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!) {
        fulfillmentOrderSplit(fulfillmentOrderId: $fulfillmentOrderId, fulfillmentOrderSplits: $fulfillmentOrderSplits) {
          fulfillmentOrders { id }
          userErrors { field message }
        }
      }
    `;
      const splitOrders: Array<{
        sourceFulfillmentOrderId: string;
        segments: ReturnType<typeof buildFulfillmentSegments>;
        resultingFulfillmentOrderIds: string[];
      }> = [];

      for (const fulfillmentOrder of openFulfillmentOrders) {
        const segments = buildFulfillmentSegments(
          Array.isArray(fulfillmentOrder.line_items) ? fulfillmentOrder.line_items : [],
          Array.isArray(order.line_items) ? order.line_items : [],
          splitDecision.threshold
        );
        const fulfillmentOrderSplits = toShopifyFulfillmentOrderSplits(segments);
        if (fulfillmentOrderSplits.length === 0) continue;

        const sourceFulfillmentOrderId = String(fulfillmentOrder.id);
        const graphqlResult = await shopifyAdminGraphql<{
          data?: {
            fulfillmentOrderSplit?: {
              fulfillmentOrders?: Array<{ id: string }>;
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        }>(mutation, {
          fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${sourceFulfillmentOrderId}`,
          fulfillmentOrderSplits,
        });
        const userErrors = graphqlResult?.data?.fulfillmentOrderSplit?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(userErrors.map((error) => error.message).join(", "));
        }

        splitOrders.push({
          sourceFulfillmentOrderId,
          segments,
          resultingFulfillmentOrderIds: (
            graphqlResult?.data?.fulfillmentOrderSplit?.fulfillmentOrders || []
          ).map((fo) => fo.id),
        });
      }

      if (splitOrders.length === 0) {
        return {
          applied: false as const,
          reason: "single_segment",
          threshold: splitDecision.threshold,
          fulfillmentOrders: [],
        };
      }

      const segmentCount = splitOrders.reduce(
        (count, splitOrder) => count + splitOrder.segments.length,
        0
      );
      console.log(
        `[Fulfillment Split] Successfully split ${shopifyOrderName} into ${segmentCount} value segments`
      );
      await slack.sendOrderMessage(
        SlackChannelEnum.SHOPIFY,
        `[Fulfillment Split] ${shopifyOrderName} split into ${segmentCount} value segments ` +
          `(total=$${orderTotal}, threshold=$${splitDecision.threshold}, country=${countryCode})`
      );
      return {
        applied: true as const,
        reason: "split_applied",
        threshold: splitDecision.threshold,
        fulfillmentOrders: splitOrders,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[Fulfillment Split] Failed for ${shopifyOrderName}: ${errorMsg}`);
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `[Fulfillment Split] ${shopifyOrderName}: split check failed (non-blocking) — ${errorMsg}`
      );
      return {
        applied: false as const,
        reason: "split_failed",
        threshold: null,
        error: errorMsg,
        fulfillmentOrders: [],
      };
    }
  });
}
