// ============================================================================
// SHOPIFY ORDER → D365 & GPS SYNC
// ============================================================================
// Processes new Shopify orders (created/paid)
// 1. Validates order (Test, High Risk, etc.)
// 2. Creates D365 Sales Order
// 3. Creates GPS Outbound Order (if applicable)
// 4. Handles Out of Stock retries

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
import { validateOrderForProcessing } from "./utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "./utils/constants";
import type { ShopifyOrderPayload } from "../events";
import { isWelcomeKitSku } from "@/lib/transformers/sku";

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",
    name: "Process Shopify Order",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.ORDER_PROCESSING,
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/order.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    // 1. Validate Order
    const validation = validateOrderForProcessing(order);

    if (!validation.valid) {
      await slack.sendErrorMessage(
        "shopify",
        `Order ${shopifyOrderName} validation failed: ${validation.reason}`
      );
      return {
        status: "failed_validation",
        reason: validation.reason,
        shopifyOrderId,
      };
    }

    if (validation.skip) {
      if (validation.reason === "High-risk order") {
        await slack.sendWarningMessage(
          "shopify",
          `Skipping High Risk Order: ${shopifyOrderName}`
        );
      }
      return {
        status: "skipped",
        reason: validation.reason,
        shopifyOrderId,
      };
    }

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // Filter for Welcome Kits only (Phase 1)
    if (!isWelcomeKitSku(order.line_items)) {
      return {
        status: "skipped_non_welcome_kit",
        orderName: shopifyOrderName,
      };
    }

    try {
      const warehouseName = determineWarehouse(
        order.shipping_address?.country_code || order.billing_address?.country_code || "US"
      );

      // 2. Check/Create D365 Order
      const existingOrder = await step.run("check-existing-d365-order", async () => {
        if (!config.features.enableDynamicsSync) return null;
        return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      });

      if (existingOrder) {
        return {
          status: "already_exists",
          d365OrderNumber: existingOrder.SalesOrderNumber,
          shopifyOrderId,
        };
      }

      const d365Header = await step.run("create-d365-header", async () => {
        const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName);
        if (!config.features.enableDynamicsSync) {
          return { SalesOrderNumber: `MOCK-${shopifyOrderId}`, request: headerRequest };
        }
        return dynamics.createSalesOrderHeaderV3(headerRequest);
      });

      const salesOrderNumber = d365Header.SalesOrderNumber;

      await step.run("create-d365-lines", async () => {
        const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);
        if (!config.features.enableDynamicsSync) return lines;

        for (const line of lines) {
          await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
        }
        return lines;
      });

      await step.sleep("wait-for-d365-propagation", "5s");

      await step.run("confirm-d365-order", async () => {
        if (!config.features.enableDynamicsSync) return;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await dynamics.confirmSalesOrder(salesOrderNumber, config.dynamics.dataAreaId);
            return;
          } catch (error) {
            const isNotFoundError =
              error instanceof Error && error.message.includes("does not exist");
            if (isNotFoundError && attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            } else {
              throw error;
            }
          }
        }
      });

      // 3. Create Prepayment
      await step.run("create-d365-prepayment", async () => {
        const amount = calculatePrepaymentAmount(order);
        if (!config.features.enableDynamicsSync) return amount;
        if (amount > 0) {
          await dynamics.createPrepayment(salesOrderNumber, config.dynamics.dataAreaId);
        }
        return amount;
      });

      // 4. Send to GPS (if applicable)
      const gpsOrderPayload = await step.run("build-gps-payload", async () => {
        try {
          return toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
        } catch (error) {
          await slack.sendWarningMessage(
            "gps",
            `Failed to build GPS payload for ${shopifyOrderName}: ${error}`
          );
          return null;
        }
      });

      const shouldSendToRealGps = shouldSendToGps(order) && config.features.enableGpsSync;

      if (shouldSendToRealGps && gpsOrderPayload) {
        try {
          await step.run("send-to-gps-warehouse", async () => {
            return gps.createOutboundOrder(
              gpsOrderPayload,
              warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
            );
          });
        } catch (error) {
          if (error instanceof OutOfStockError) {
            await slack.sendWarningMessage(
              "gpslow",
              `GPS Out of Stock for ${shopifyOrderName}: ${error.message}`
            );
            
            await step.sleep("wait-for-stock", `${config.delays.outOfStockRetryHours}h`);
            await step.run("retry-gps-after-oos", async () => {
              return gps.createOutboundOrder(
                gpsOrderPayload,
                warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
              );
            });
          } else {
            throw error;
          }
        }
      }

      await slack.sendOrderMessage(
        `Order ${shopifyOrderName} processed successfully. D365: ${salesOrderNumber}`
      );

      return {
        status: "success",
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNumber,
        warehouse: warehouseName,
        processedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const channel = slack.determineErrorChannel(errorMsg);
      await slack.sendErrorMessage(
        channel,
        `Process Order Failed: ${shopifyOrderName} - ${errorMsg}`
      );
      throw error;
    }
  }
);

export const processShopifyOrderPaid = inngest.createFunction(
  {
    id: "process-shopify-order-paid",
    name: "Process Shopify Order (Paid)",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.DEFAULT,
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
    await step.sendEvent("forward-to-order-created", {
      name: "shopify/order.created",
      data: event.data,
    });

    return {
      status: "forwarded",
      shopifyOrderId: event.data.shopifyOrderId,
      forwardedTo: "shopify/order.created",
    };
  }
);
