import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import type { ShopifyOrderPayload, ShopifyFulfillment } from "../events";
import { isDummyFulfillment } from "./utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "./utils/constants";

export const processShopifyFulfillment = inngest.createFunction(
  {
    id: "process-shopify-fulfillment",
    name: "Process Shopify Fulfillment",
    idempotency:
      "event.data.shopifyOrderId + '-' + event.data.fulfillments.map(f => f.id).join(',')",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.FULFILLMENT,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/order.fulfilled" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, fulfillments } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentCount: fulfillments.length,
      };
    }

    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order) {
      return {
        status: "no_d365_order",
        shopifyOrderId,
        shopifyOrderName,
        message: "D365 order not found - may not have been created yet",
      };
    }

    const fulfillmentResults = await step.run("process-fulfillments", async () => {
      if (!config.features.enableDynamicsSync) {
        return fulfillments.map((f: ShopifyFulfillment) => ({
          fulfillmentId: f.id,
          status: "skipped_dynamics_disabled",
        }));
      }

      const results = [];

      for (const fulfillment of fulfillments) {
        if (isDummyFulfillment(fulfillment)) {
          results.push({
            fulfillmentId: fulfillment.id,
            status: "skipped_dummy",
          });
          continue;
        }

        try {
          const fulfillmentLines = fulfillment.line_items.map(
            (item: { sku: string; quantity: number }) => ({
              itemNumber: item.sku,
              quantity: item.quantity,
              trackingNumber: fulfillment.tracking_number || undefined,
              shippingSiteId: "Prenetics",
              lotId: undefined,
            })
          );

          await dynamics.createFulfilment({
            dataAreaId: d365Order.dataAreaId || config.dynamics.dataAreaId,
            salesOrderNumber: d365Order.SalesOrderNumber!,
            type: "PackingSlip",
            confirmedShippedDate: fulfillment.created_at
              ? new Date(fulfillment.created_at).toISOString().split("T")[0]
              : new Date().toISOString().split("T")[0],
            lines: fulfillmentLines,
          });

          results.push({
            fulfillmentId: fulfillment.id,
            status: "success",
            trackingNumber: fulfillment.tracking_number,
            carrier: fulfillment.tracking_company,
          });
        } catch (error) {
          results.push({
            fulfillmentId: fulfillment.id,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return results;
    });

    return {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      fulfillmentCount: fulfillments.length,
      fulfillmentResults,
      processedAt: new Date().toISOString(),
    };
  }
);


