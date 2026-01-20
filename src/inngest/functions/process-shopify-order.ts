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
    // Concurrency limit to prevent overwhelming downstream systems
    concurrency: {
      limit: 10,
    },
  },
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
    // STEP 4: Confirm D365 Sales Order
    // =========================================================================
    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }
      await dynamics.confirmSalesOrder(salesOrderNumber, config.dynamics.dataAreaId);
    });

    console.log(`[Battle Bus] Confirmed D365 order: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 5: Create D365 Prepayment
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
    // STEP 6: Send to GPS Warehouse (with self-healing retry)
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
