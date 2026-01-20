// ============================================================================
// INNGEST FUNCTION: Process Shopify Order Update (DEBOUNCED)
// ============================================================================
// This handles the "noisy" Shopify order.updated webhooks
// Shopify often sends 5+ updates in 2 seconds for a single change
// DEBOUNCE ensures we only process the LAST update after things settle
//
// Example: Customer updates shipping address
// - Shopify sends: update1, update2, update3, update4, update5 (in 2 seconds)
// - Without debounce: We'd process all 5, wasting API calls
// - With debounce: We wait 10s, then process ONLY update5 (the latest)

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import type { ShopifyOrderPayload } from "../events";

export const processOrderUpdate = inngest.createFunction(
  {
    id: "process-order-update",
    name: "Process Order Update (Debounced)",

    // =========================================================================
    // DEBOUNCE: The magic sauce for handling Shopify's noisy webhooks
    // Wait 10 seconds after the LAST update before processing
    // If more updates come in during that 10s, reset the timer
    // =========================================================================
    debounce: {
      key: "event.data.shopifyOrderId", // Group by order ID
      period: "10s", // Wait 10 seconds for things to settle
      timeout: "5m", // Max wait time before forcing execution
    },

    // =========================================================================
    // THROTTLING: Prevent overwhelming D365 API
    // =========================================================================
    throttle: {
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },

    // =========================================================================
    // KEY-BASED CONCURRENCY: Process updates for same order sequentially
    // =========================================================================
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

    console.log(`[Battle Bus] Processing order update: ${shopifyOrderName} (${shopifyOrderId})`);
    console.log(`[Battle Bus] Changed fields: ${changedFields?.join(", ") || "unknown"}`);

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      console.log(`[Dry Run] Would process order update: ${shopifyOrderName}`);
      return {
        status: "dry_run",
        orderId: shopifyOrderId,
        orderName: shopifyOrderName,
        changedFields,
      };
    }

    // =========================================================================
    // STEP 1: Check if order exists in D365
    // =========================================================================
    const d365Order = await step.run("check-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order) {
      console.log(`[Battle Bus] Order ${shopifyOrderId} not found in D365 - skipping update`);
      return {
        status: "skipped",
        reason: "Order not found in D365",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // =========================================================================
    // STEP 2: Determine what needs to be updated
    // =========================================================================
    const updateActions = await step.run("determine-update-actions", async () => {
      const actions: string[] = [];

      // Check for shipping address changes
      if (changedFields?.includes("shipping_address") || !changedFields) {
        actions.push("update_shipping_address");
      }

      // Check for note/tag changes
      if (changedFields?.includes("note") || changedFields?.includes("tags")) {
        actions.push("update_notes");
      }

      // Check for customer changes
      if (changedFields?.includes("customer")) {
        actions.push("update_customer");
      }

      return actions;
    });

    console.log(`[Battle Bus] Update actions: ${updateActions.join(", ")}`);

    // =========================================================================
    // STEP 3: Update D365 Sales Order (if needed)
    // =========================================================================
    if (updateActions.length > 0 && config.features.enableDynamicsSync) {
      await step.run("update-d365-order", async () => {
        // TODO: Implement D365 order update
        // This would call dynamics.updateSalesOrder() with the changed fields
        console.log(`[Battle Bus] Would update D365 order ${d365Order.SalesOrderNumber} with actions: ${updateActions.join(", ")}`);

        // Example implementation:
        // if (updateActions.includes("update_shipping_address")) {
        //   await dynamics.updateSalesOrderAddress(d365Order.SalesOrderNumber, order.shipping_address);
        // }
      });
    }

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
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
