// ============================================================================
// INNGEST FUNCTION: Process Shopify Order
// ============================================================================
// This replaces the old "shopify" task type from spock-store taskprocessor.ts
// Durable execution with checkpointing via step.run()

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
  determineWarehouse,
} from "@/lib/transformers/order";
import type { ShopifyOrderPayload } from "../events";

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
  // NOTE: Inngest dev server doesn't support array triggers reliably,
  // so the main processor listens to order.created and we use a
  // separate function below to forward order.paid events.
  { event: "shopify/order.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
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
      const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName);

      // In local/dev we often don't want to hit real D365, but we still
      // want to see exactly what would be sent. So:
      // - When enableDynamicsSync=false, we SKIP the HTTP call but keep
      //   the request payload for logging + mock DB.
      if (!config.features.enableDynamicsSync) {
        return { SalesOrderNumber: `MOCK-${shopifyOrderId}`, request: headerRequest };
      }

      return dynamics.createSalesOrderHeaderV3(headerRequest);
    });

    const salesOrderNumber = d365Header.SalesOrderNumber;

    // =========================================================================
    // STEP 3: Create D365 Sales Order Lines
    // =========================================================================
    const d365Lines = await step.run("create-d365-lines", async () => {
      const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);

      if (!config.features.enableDynamicsSync) {
        return lines;
      }

      for (const line of lines) {
        await dynamics.createSalesOrderLine({
          ...line,
          salesOrderNumber,
        });
      }

      return lines;
    });

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
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          } else {
            throw error; // Re-throw on final attempt or non-retryable error
          }
        }
      }
    });

    // =========================================================================
    // STEP 6: Create D365 Prepayment
    // =========================================================================
    const prepaymentAmount = await step.run("create-d365-prepayment", async () => {
      const amount = calculatePrepaymentAmount(order);

      if (!config.features.enableDynamicsSync) {
        return amount;
      }

      if (amount > 0) {
        await dynamics.createPrepayment(salesOrderNumber, config.dynamics.dataAreaId);
      }

      return amount;
    });

    // =========================================================================
    // STEP 7: Send to GPS Warehouse (with self-healing retry)
    // =========================================================================
    // Always build GPS payload, even if we won't send to real GPS
    const gpsOrderPayload = await step.run("build-gps-payload", async () => {
      try {
        return toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
      } catch (error) {
        return null;
      }
    });

    // Only send to real GPS if shouldSendToGps is true AND enableGpsSync is enabled
    const shouldSendToRealGps = shouldSendToGps(order) && config.features.enableGpsSync;

    if (shouldSendToRealGps && gpsOrderPayload) {
      try {
        await step.run("send-to-gps-warehouse", async () => {
          return gps.createOutboundOrder(gpsOrderPayload, warehouseName as "GPS Warehouse" | "GPS UK Warehouse");
        });
      } catch (error) {
        // =====================================================================
        // SELF-HEALING: Out of Stock Retry
        // =====================================================================
        if (error instanceof OutOfStockError) {
          // Sleep and retry - this is the "Battle Bus" magic!
          await step.sleep("wait-for-stock", `${config.delays.outOfStockRetryHours}h`);

          // Retry after sleep - rebuild payload if needed
          await step.run("retry-gps-after-oos", async () => {
            const retryPayload = gpsOrderPayload || toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
            return gps.createOutboundOrder(retryPayload, warehouseName as "GPS Warehouse" | "GPS UK Warehouse");
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
