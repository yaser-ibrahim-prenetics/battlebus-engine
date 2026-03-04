import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as csPlatform from "@/lib/clients/cs-platform";
import type { ShopifyOrderPayload } from "../events";
import { THROTTLE_CONFIGS, RETRY_CONFIGS } from "@/lib/utils/constants";

export const processOrderUpdate = inngest.createFunction(
  {
    id: "process-order-update",
    name: "Process Order Update (Debounced)",
    debounce: {
      key: "event.data.shopifyOrderId",
      period: "10s",
      timeout: "5m",
    },
    throttle: {
      ...THROTTLE_CONFIGS.SHOPIFY,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],
    retries: RETRY_CONFIGS.LOW_PRIORITY,
  },
  { event: "shopify/order.updated" },
  async ({ event, step, runId }: { event: any; step: any; runId: any }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, changedFields } = event.data;
    const inngestIdempotencyKey = event.id;
    const inngestRunId = runId;
    const order = orderJson as ShopifyOrderPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        orderId: shopifyOrderId,
        orderName: shopifyOrderName,
        changedFields,
      };
    }

    const d365Order = await step.run("check-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
      return dynamics.getSalesOrderByShopifyId(shopifyOrderName);
    });

    if (!d365Order) {
      return {
        status: "skipped",
        reason: "Order not found in D365",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    const updateActions = await step.run("determine-update-actions", async () => {
      const actions: string[] = [];

      if (changedFields?.includes("shipping_address") || !changedFields) {
        actions.push("update_shipping_address");
      }

      if (changedFields?.includes("note") || changedFields?.includes("tags")) {
        actions.push("update_notes");
      }

      if (changedFields?.includes("customer")) {
        actions.push("update_customer");
      }

      return actions;
    });

    if (updateActions.length > 0 && config.features.enableDynamicsSync) {
      await step.run("update-d365-order", async () => {
        // Implement D365 order update
        await dynamics.updateSalesOrderHeaderV3(shopifyOrderId, order);
      });
    }

    const result = {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      updateActions,
      processedAt: new Date().toISOString(),
    };

    // Send order updated event to CS platform
    await csPlatform.sendOrderUpdated(order, changedFields, { inngestIdempotencyKey, inngestRunId });

    return result;
  }
);
