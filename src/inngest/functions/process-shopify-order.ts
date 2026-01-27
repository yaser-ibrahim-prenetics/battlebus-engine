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
import * as shopify from "@/lib/clients";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
  determineWarehouse,
} from "@/lib/transformers/order";
import {
  validateOrderForProcessing,
  validateOrderCompletely,
} from "@/lib/utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { CancelReasonEnum, type ShopifyOrderPayload } from "../events";
import { slackChannelEnum } from "@/lib/types/slack";

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
  [{ event: "shopify/order.created" }, { event: "shopify/order.paid" }],
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // Comprehensive order validation - all checks in one place
    const validation = await step.run("validate-order-completely", async () => {
      return validateOrderCompletely(order, shopifyOrderId, shopifyOrderName);
    });

    // Handle validation failures
    if (!validation.valid || validation.skip) {
      if (validation.status === "failed_validation") {
        await slack.sendErrorMessage(
          "shopify",
          `Order ${shopifyOrderName} validation failed: ${validation.reason}`
        );
      } else if (validation.status === "skipped" && validation.reason === "High-risk order") {
        await slack.sendWarningMessage(
          "shopify",
          `Skipping High Risk Order: ${shopifyOrderName}`
        );
      } else if (validation.status === "fraud_hold") {
        await slack.sendWarningMessage(
          slackChannelEnum.SHOPIFY,
          `[Battle Bus] Skip high risk order for ${shopifyOrderId}`
        );
      } else if (validation.status === "cancelled") {
        const cancelReason = CancelReasonEnum[validation.cancelReason as keyof typeof CancelReasonEnum] || validation.cancelReason;
        console.log(`[Battle Bus] Order was cancelled due to ${cancelReason}`);
        await slack.sendWarningMessage(
          slackChannelEnum.SHOPIFY,
          `[Battle Bus] Order was cancelled due to ${cancelReason}`
        );
      } else if (validation.status === "skipped_non_welcome_kit") {
        const skus = validation.skus?.join(", ") || "";
        console.log(`[Order] ⏭️ Skipping ${shopifyOrderName} - Not a Welcome Kit. SKUs: ${skus}`);
      }

      return {
        status: validation.status,
        reason: validation.reason,
        shopifyOrderId,
        orderName: shopifyOrderName,
        ...(validation.message && { message: validation.message }),
        ...(validation.skus && { skus: validation.skus }),
        ...(validation.cancelReason && { cancelReason: validation.cancelReason }),
      };
    }

    try {
      const warehouseName = determineWarehouse(
        order.shipping_address?.country_code || order.billing_address?.country_code || "US"
      );

      // D365 calls controlled by ENABLE_DYNAMICS_SYNC
      const skipD365 = !config.features.enableDynamicsSync;

      // 2. Check for existing D365 order (idempotency check)
      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
      const existingOrder = await step.run("check-existing-d365-order", async () => {
        if (skipD365) {
          console.log("[D365] Dynamics sync disabled, skipping order lookup");
          return null;
        }
        console.log(`[D365] Looking up existing order for Shopify Name: ${shopifyOrderName}`);
        return dynamics.getSalesOrderByShopifyId(shopifyOrderName);
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
        if (skipD365) {
          return { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: headerRequest };
        }
        return dynamics.createSalesOrderHeaderV3(headerRequest);
      });

      const salesOrderNumber = d365Header.SalesOrderNumber;

      await step.run("create-d365-lines", async () => {
        const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);
        if (skipD365) {
          return lines;
        }

        for (const line of lines) {
          await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
        }
        return lines;
      });

      if (!skipD365) {
        await step.sleep("wait-for-d365-propagation", "5s");
      }

      await step.run("confirm-d365-order", async () => {
        if (skipD365) {
          return;
        }

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
        if (skipD365) {
          return amount;
        }
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

      // Send to GPS warehouse
      const gpsResult = await step.run("send-to-gps-warehouse", async () => {
        // If GPS is enabled and we have a payload, make the real call
        if (shouldSendToRealGps && gpsOrderPayload) {
          try {
            const result = await gps.createOutboundOrder(
              gpsOrderPayload,
              warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
            );
            return { type: "real", result };
          } catch (error) {
            if (error instanceof OutOfStockError) {
              console.log(`[GPS] ⚠️ Out of stock: ${error.message}`);
              return { type: "out_of_stock", error: error.message };
            }
            throw error;
          }
        }

        // Skip if GPS not enabled
        return { type: "skipped", reason: "GPS sync disabled or no payload" };
      });

      // Handle out of stock retry
      if (gpsResult.type === "out_of_stock" && gpsOrderPayload) {
        const oosError = "error" in gpsResult ? gpsResult.error : "Unknown";
        await slack.sendWarningMessage(
          "gpslow",
          `GPS Out of Stock for ${shopifyOrderName}: ${oosError}`
        );
        
        await step.sleep("wait-for-stock", `${config.delays.outOfStockRetryHours}h`);
        await step.run("retry-gps-after-oos", async () => {
          return gps.createOutboundOrder(
            gpsOrderPayload,
            warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
          );
        });
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
        gpsResult,
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

