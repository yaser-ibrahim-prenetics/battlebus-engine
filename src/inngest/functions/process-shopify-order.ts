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
  toD365SalesOrderHeader,
  toD365SalesOrderLine,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
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
        return { SalesOrderNumber: `SKIP-${shopifyOrderId}` };
      }

      const header = toD365SalesOrderHeader(orderJson as unknown as Parameters<typeof toD365SalesOrderHeader>[0]);
      return dynamics.createSalesOrderHeader(header);
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

      const order = orderJson as unknown as Parameters<typeof toD365SalesOrderLine>[0] & { line_items: Parameters<typeof toD365SalesOrderLine>[0][] };
      
      for (const lineItem of order.line_items) {
        if (lineItem.requires_shipping && !lineItem.gift_card) {
          const line = toD365SalesOrderLine(lineItem, salesOrderNumber);
          await dynamics.createSalesOrderLine(line);
        }
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
      await dynamics.confirmSalesOrder(config.dynamics.dataAreaId, salesOrderNumber);
    });

    console.log(`[Battle Bus] Confirmed D365 order: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 5: Create D365 Prepayment
    // =========================================================================
    await step.run("create-d365-prepayment", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const order = orderJson as unknown as Parameters<typeof calculatePrepaymentAmount>[0];
      const prepaymentAmount = calculatePrepaymentAmount(order);

      await dynamics.createPrepayment({
        dataAreaId: config.dynamics.dataAreaId,
        SalesOrderNumber: salesOrderNumber,
        PrepaymentAmount: prepaymentAmount,
        PaymentReference: `SHOPIFY-${shopifyOrderId}`,
        PaymentDate: new Date().toISOString().split("T")[0],
        CurrencyCode: order.currency,
      });
    });

    console.log(`[Battle Bus] Created prepayment for: ${salesOrderNumber}`);

    // =========================================================================
    // STEP 6: Send to GPS Warehouse (with self-healing retry)
    // =========================================================================
    const order = orderJson as unknown as Parameters<typeof shouldSendToGps>[0];
    
    if (shouldSendToGps(order) && config.features.enableGpsSync) {
      try {
        await step.run("send-to-gps-warehouse", async () => {
          const gpsOrder = toGpsOutboundOrder(order);
          return gps.createOutboundOrder(gpsOrder);
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
            const gpsOrder = toGpsOutboundOrder(order);
            return gps.createOutboundOrder(gpsOrder);
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
      processedAt: new Date().toISOString(),
    };
  }
);
