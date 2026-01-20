// ============================================================================
// PROCESS ORDER CANCELLATION
// ============================================================================
// Handles shopify/order.cancelled events
// Cancels the order in D365 and GPS if already submitted

import { inngest } from "../client";
import { config } from "@/lib/config";
import { dynamics, gps } from "@/lib/clients";

export const processOrderCancellation = inngest.createFunction(
  {
    id: "process-order-cancellation",
    name: "Process Order Cancellation",
    retries: 3,

    // =========================================================================
    // IDEMPOTENCY: Prevent duplicate cancellation processing
    // =========================================================================
    idempotency: "event.data.shopifyOrderId",

    // =========================================================================
    // THROTTLING: Prevent overwhelming D365/GPS APIs during mass cancellations
    // =========================================================================
    throttle: {
      limit: 5,
      period: "1s",
      key: "event.data.shopifyStore",
    },

    // =========================================================================
    // KEY-BASED CONCURRENCY: Only 1 cancellation per order at a time
    // =========================================================================
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],

    // =========================================================================
    // RATE LIMIT: Prevent cancellation spam - max 1 per order per hour
    // =========================================================================
    rateLimit: {
      key: "event.data.shopifyOrderId",
      limit: 1,
      period: "1h",
    },
  },
  { event: "shopify/order.cancelled" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, cancelReason } = event.data;

    console.log(`[Cancellation] Processing cancellation for ${shopifyOrderName}`);
    console.log(`[Cancellation] Reason: ${cancelReason || "Not specified"}`);

    // ========================================================================
    // STEP 1: Check if order exists in D365
    // ========================================================================
    const d365Order = await step.run("check-d365-order", async () => {
      console.log(`[Cancellation] Checking D365 for order ${shopifyOrderId}`);

      const existingOrder = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);

      if (!existingOrder) {
        console.log(`[Cancellation] Order ${shopifyOrderId} not found in D365 - nothing to cancel`);
        return null;
      }

      console.log(`[Cancellation] Found D365 order: ${existingOrder.SalesOrderNumber}`);
      return existingOrder;
    });

    // If no D365 order, nothing to cancel
    if (!d365Order) {
      return {
        status: "skipped",
        reason: "Order not found in D365",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // ========================================================================
    // STEP 2: Cancel in GPS (if submitted)
    // ========================================================================
    const gpsCancellation = await step.run("cancel-gps-order", async () => {
      if (config.features.dryRunMode) {
        console.log(`[DRY RUN] Would cancel GPS order for ${shopifyOrderId}`);
        return { dryRun: true, status: "would_cancel" };
      }

      try {
        // GPS uses the Shopify order ID as the customer order number
        const result = await gps.cancelOutboundOrder(shopifyOrderId);
        console.log(`[Cancellation] GPS cancellation result:`, result);
        return { status: "cancelled", result };
      } catch (error) {
        // GPS might return error if order not found or already shipped
        console.log(`[Cancellation] GPS cancellation failed (may be expected):`, error);
        return { status: "failed", error: String(error) };
      }
    });

    // ========================================================================
    // STEP 3: Cancel in D365
    // ========================================================================
    const d365Cancellation = await step.run("cancel-d365-order", async () => {
      if (config.features.dryRunMode) {
        console.log(`[DRY RUN] Would cancel D365 order ${d365Order.SalesOrderNumber}`);
        return { dryRun: true, status: "would_cancel" };
      }

      // TODO: Implement D365 cancellation
      // This typically involves:
      // 1. Check if order is confirmed - if not, can delete
      // 2. If confirmed but not shipped - cancel the order
      // 3. If shipped - need to create return order instead
      console.log(`[Cancellation] TODO: Implement D365 cancellation for ${d365Order.SalesOrderNumber}`);
      return { status: "not_implemented" };
    });

    // ========================================================================
    // RESULT
    // ========================================================================
    return {
      status: "processed",
      shopifyOrderId,
      shopifyOrderName,
      cancelReason,
      d365OrderNumber: d365Order.SalesOrderNumber,
      gpsCancellation,
      d365Cancellation,
    };
  }
);
