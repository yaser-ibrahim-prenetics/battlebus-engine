import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import type { ShopifyOrderPayload } from "../events";

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
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],
    retries: 3,
  },
  { event: "shopify/order.updated" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, changedFields } = event.data;
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
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
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
        // TODO: Implement D365 order update
      });
    }

    return {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      updateActions,
      processedAt: new Date().toISOString(),
    };
  }
);
