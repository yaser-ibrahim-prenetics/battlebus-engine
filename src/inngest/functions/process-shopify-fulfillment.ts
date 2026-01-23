// ============================================================================
// INNGEST FUNCTION: Process Shopify Fulfillment
// ============================================================================
// Handles orders/fulfilled webhook from Shopify
// Syncs fulfillment to Dynamics 365 (Flow 7: Shopify Direct Fulfillment)
// This is used when Shopify is the source of truth (manual fulfillment, Stord, etc.)

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import type { ShopifyOrderPayload, ShopifyFulfillment } from "../events";

export const processShopifyFulfillment = inngest.createFunction(
  {
    id: "process-shopify-fulfillment",
    name: "Process Shopify Fulfillment",
    // Idempotency: Prevent duplicate processing of the same fulfillment
    idempotency: "event.data.shopifyOrderId + '-' + event.data.fulfillments.map(f => f.id).join(',')",
    retries: 5,

    // =========================================================================
    // THROTTLING: Prevent overwhelming Dynamics API
    // =========================================================================
    throttle: {
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },

    // =========================================================================
    // KEY-BASED CONCURRENCY: Prevent race conditions
    // Only 1 fulfillment processed at a time per Shopify order
    // =========================================================================
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],
  },
  { event: "shopify/order.fulfilled" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, fulfillments } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentCount: fulfillments.length,
      };
    }

    // =========================================================================
    // STEP 1: Get D365 Sales Order
    // =========================================================================
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }

      // Try to find by Shopify order ID
      const order = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      if (!order) {
        return null;
      }

      return order;
    });

    if (!d365Order) {
      return {
        status: "no_d365_order",
        shopifyOrderId,
        shopifyOrderName,
        message: "D365 order not found - may not have been created yet",
      };
    }

    // =========================================================================
    // STEP 2: Process Each Fulfillment
    // =========================================================================
    const fulfillmentResults = await step.run("process-fulfillments", async () => {
      if (!config.features.enableDynamicsSync) {
        return fulfillments.map((f) => ({
          fulfillmentId: f.id,
          status: "skipped_dynamics_disabled",
        }));
      }

      const results = [];

      for (const fulfillment of fulfillments) {
        // Skip dummy/refund fulfillments
        if (isDummyFulfillment(fulfillment)) {
          results.push({
            fulfillmentId: fulfillment.id,
            status: "skipped_dummy",
          });
          continue;
        }

        try {
          // Map fulfillment to D365 format
          const fulfillmentLines = fulfillment.line_items.map((item) => ({
            itemNumber: item.sku,
            quantity: item.quantity,
            trackingNumber: fulfillment.tracking_number || undefined,
            shippingSiteId: "Prenetics",
            // Note: lotId would come from D365 order lines if needed
            lotId: undefined,
          }));

          // Create D365 fulfillment (packing slip)
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

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if fulfillment is a dummy/refund fulfillment
 * Filters out adjustment SKUs and negative fulfillments
 */
function isDummyFulfillment(fulfillment: ShopifyFulfillment): boolean {
  // Check if all line items are dummy/adjustment SKUs
  const hasRealItems = fulfillment.line_items.some((item) => {
    const sku = item.sku || "";
    return (
      sku.length > 0 &&
      !sku.startsWith("ADJUSTMENT") &&
      !sku.startsWith("SHIPPING") &&
      !item.price.startsWith("-")
    );
  });

  return !hasRealItems;
}

