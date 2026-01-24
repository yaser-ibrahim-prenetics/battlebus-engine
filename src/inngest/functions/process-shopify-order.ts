// ============================================================================
// INNGEST FUNCTION: Process Shopify Order
// ============================================================================
// This replaces the old "shopify" task type from spock-store taskprocessor.ts
// Durable execution with checkpointing via step.run()

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
  determineWarehouse,
  isOrderTaggedWith,
} from "@/lib/transformers/order";
import type { ShopifyOrderPayload } from "../events";
import { isWelcomeKitSku } from "@/lib/transformers/sku";

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",
    name: "Process Shopify Order",
    // Idempotency: Prevent duplicate processing of the same order
    idempotency: "event.data.shopifyOrderId",
    // Retry configuration
    retries: 5,

    // =========================================================================
    // THROTTLING: Prevent "hammering" D365 API (Leon's #1 concern)
    // Limits to 10 function runs per second, per store
    // This keeps us well under D365's rate limits (~60-100 req/min)
    // =========================================================================
    throttle: {
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },

    // =========================================================================
    // KEY-BASED CONCURRENCY: Prevent race conditions per warehouse
    // Orders for the same country/warehouse are processed sequentially
    // Different warehouses can process in parallel
    // =========================================================================
    concurrency: [
      {
        limit: 3, // Max 3 concurrent orders per warehouse region
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
  },
  // NOTE: Inngest dev server doesn't support array triggers
  // Using order.created - the webhook route sends this for orders/create
  // For orders/paid, we have a separate handler below
  { event: "shopify/order.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    console.log(`[Battle Bus] Processing order: ${shopifyOrderName} (${shopifyOrderId})`);

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      console.log(`[Dry Run] Would process order: ${shopifyOrderName}`);
      return {
        status: "dry_run",
        orderId: shopifyOrderId,
        orderName: shopifyOrderName,
      };
    }

    // Determine warehouse based on shipping address
    const warehouseName = determineWarehouse(
      order.shipping_address?.country_code || order.billing_address?.country_code || "US"
    );

    // =========================================================================
    // TODO (Nazreen): Check for high-risk fraud orders
    // =========================================================================
    // Before processing, check if this order is flagged as high-risk fraud.
    // Shopify provides fraud analysis in the order payload.
    // If high-risk, we should:
    // 1. Skip processing (don't send to D365 or GPS)
    // 2. Send a Slack notification to the team
    // 3. Return early with status "fraud_hold"
    const validated = await step.run("validate-shopify-order", async () => {
      if (isOrderTaggedWith(order, 'high-risk-order')) {
        slack.sendWarningMessage('shopify', `[Battle Bus] Skip high risk order for ${shopifyOrderId}})`);
        return false;
      }
      return true;
    });
    if (!validated) {
      return {
        status: "fraud_hold",
        orderName: shopifyOrderName,
      };
    }

    //
    // Check order.fraud_analysis or order.risks array from Shopify
    // See: https://shopify.dev/docs/api/admin-rest/2024-01/resources/order#resource-object
    // =========================================================================

    // =========================================================================
    // TODO (Nazreen): Filter for Welcome Kits only (Phase 1)
    // =========================================================================
    // For the initial rollout, we only want to process "Welcome Kit" orders.
    // Check if ALL line items are welcome kit SKUs before proceeding.
    // If not a welcome kit order, return early with status "skipped_non_welcome_kit"
    //
    // Welcome kit SKUs to check: (get list from product team)
    // - IM8-WK-XXXXX pattern?
    //
    // This filter can be removed once we're confident the system is stable.
    // =========================================================================
    if (!isWelcomeKitSku(order.line_items)) {
      return {
        status: "skipped_non_welcome_kit",
        orderName: shopifyOrderName,
      }
    }

    // =========================================================================
    // STEP 1: Check for existing D365 order (idempotency check)
    // =========================================================================
    const existingOrder = await step.run("check-existing-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (existingOrder) {
      console.log(`[Battle Bus] Order already exists in D365: ${existingOrder.SalesOrderNumber}`);
      return {
        status: "already_exists",
        d365OrderNumber: existingOrder.SalesOrderNumber,
        shopifyOrderId,
      };
    }

    // =========================================================================
    // STEP 2: Create D365 Sales Order Header
    // =========================================================================
    const d365Header = await step.run("create-d365-header", async () => {
      if (!config.features.enableDynamicsSync) {
        return { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: {} };
      }

      const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName);
      return dynamics.createSalesOrderHeaderV3(headerRequest);
    });

    const salesOrderNumber = d365Header.SalesOrderNumber;
    console.log(`[Battle Bus] Created D365 header: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 3: Create D365 Sales Order Lines
    // =========================================================================
    await step.run("create-d365-lines", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);

      for (const line of lines) {
        await dynamics.createSalesOrderLine({
          ...line,
          salesOrderNumber,
        });
      }
    });

    console.log(`[Battle Bus] Created D365 lines for: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 4: Wait for D365 order propagation
    // D365 has eventual consistency - the order may not be immediately available
    // after creation. Wait a few seconds before confirming.
    // =========================================================================
    await step.sleep("wait-for-d365-propagation", "5s");

    // =========================================================================
    // STEP 5: Confirm D365 Sales Order (with retry for propagation delay)
    // =========================================================================
    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      // Retry logic for D365 eventual consistency
      const maxRetries = 3;
      const retryDelayMs = 3000;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await dynamics.confirmSalesOrder(salesOrderNumber, config.dynamics.dataAreaId);
          return; // Success, exit the retry loop
        } catch (error) {
          const isNotFoundError = error instanceof Error && 
            error.message.includes("does not exist");
          
          if (isNotFoundError && attempt < maxRetries) {
            console.log(`[Battle Bus] D365 order not ready yet, retry ${attempt}/${maxRetries} in ${retryDelayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          } else {
            throw error; // Re-throw on final attempt or non-retryable error
          }
        }
      }
    });

    console.log(`[Battle Bus] Confirmed D365 order: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 6: Create D365 Prepayment
    // =========================================================================
    await step.run("create-d365-prepayment", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const prepaymentAmount = calculatePrepaymentAmount(order);

      if (prepaymentAmount > 0) {
        await dynamics.createPrepayment(salesOrderNumber, config.dynamics.dataAreaId);
      }
    });

    console.log(`[Battle Bus] Created prepayment for: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 7: Send to GPS Warehouse (with self-healing retry)
    // =========================================================================
    if (shouldSendToGps(order) && config.features.enableGpsSync) {
      try {
        await step.run("send-to-gps-warehouse", async () => {
          const gpsOrder = toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
          return gps.createOutboundOrder(gpsOrder, warehouseName as "GPS Warehouse" | "GPS UK Warehouse");
        });

        console.log(`[Battle Bus] Sent to GPS warehouse: ${shopifyOrderName}`);
      } catch (error) {
        // =====================================================================
        // SELF-HEALING: Out of Stock Retry
        // =====================================================================
        if (error instanceof OutOfStockError) {
          console.log(`[Battle Bus] Out of stock, sleeping for ${config.delays.outOfStockRetryHours} hours`);

          // Sleep and retry - this is the "Battle Bus" magic!
          await step.sleep("wait-for-stock", `${config.delays.outOfStockRetryHours}h`);

          // Retry after sleep
          await step.run("retry-gps-after-oos", async () => {
            const gpsOrder = toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
            return gps.createOutboundOrder(gpsOrder, warehouseName as "GPS Warehouse" | "GPS UK Warehouse");
          });
        } else {
          throw error; // Re-throw non-OOS errors for Inngest retry
        }
      }
    }

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
    return {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: salesOrderNumber,
      warehouse: warehouseName,
      processedAt: new Date().toISOString(),
    };
  }
);

// ============================================================================
// INNGEST FUNCTION: Process Shopify Order (Paid Trigger)
// ============================================================================
// This handles the orders/paid webhook by forwarding to the main order processor
// Inngest dev server doesn't support array triggers, so we need separate functions
export const processShopifyOrderPaid = inngest.createFunction(
  {
    id: "process-shopify-order-paid",
    name: "Process Shopify Order (Paid)",
    // Same idempotency as main function - prevents duplicate processing
    idempotency: "event.data.shopifyOrderId",
    retries: 5,
    throttle: {
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        limit: 3,
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
  },
  { event: "shopify/order.paid" },
  async ({ event, step }) => {
    // Forward to the main order processing by sending order.created event
    // This ensures both triggers use the same processing logic
    await step.sendEvent("forward-to-order-created", {
      name: "shopify/order.created",
      data: event.data,
    });

    return {
      status: "forwarded",
      shopifyOrderId: event.data.shopifyOrderId,
      shopifyOrderName: event.data.shopifyOrderName,
      forwardedTo: "shopify/order.created",
    };
  }
);
