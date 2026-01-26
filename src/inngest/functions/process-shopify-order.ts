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
import { validateOrderForProcessing } from "@/lib/utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
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
  [{ event: "shopify/order.created" }, { event: "shopify/order.paid" }],
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
    const isWelcomeKit = isWelcomeKitSku(order.line_items);
    if (!isWelcomeKit && !config.features.testingMode) {
      return {
        status: "skipped_non_welcome_kit",
        orderName: shopifyOrderName,
      };
    }
    if (!isWelcomeKit && config.features.testingMode) {
      console.log(`[Order] 🧪 TESTING_MODE: ${shopifyOrderName} is not a Welcome Kit, but continuing...`);
    }

    try {
      const warehouseName = determineWarehouse(
        order.shipping_address?.country_code || order.billing_address?.country_code || "US"
      );

      // Skip real D365 calls in testing mode
      const skipD365 = !config.features.enableDynamicsSync || config.features.testingMode;

      // 2. Check/Create D365 Order
      const existingOrder = await step.run("check-existing-d365-order", async () => {
        if (skipD365) {
          console.log("[D365] 🧪 TESTING_MODE: Skipping D365 order lookup");
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

      const d365Header = await step.run("create-d365-header", async () => {
        const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName);
        if (skipD365) {
          const mockOrderNumber = `TEST-${shopifyOrderId}`;
          console.log(`[D365] 🧪 TESTING_MODE: Mock D365 order created: ${mockOrderNumber}`);
          return { SalesOrderNumber: mockOrderNumber, request: headerRequest };
        }
        return dynamics.createSalesOrderHeaderV3(headerRequest);
      });

      const salesOrderNumber = d365Header.SalesOrderNumber;

      await step.run("create-d365-lines", async () => {
        const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);
        if (skipD365) {
          console.log(`[D365] 🧪 TESTING_MODE: Mock D365 lines created: ${lines.length} items`);
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
          console.log(`[D365] 🧪 TESTING_MODE: Mock D365 order confirmed: ${salesOrderNumber}`);
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
          console.log(`[D365] 🧪 TESTING_MODE: Mock prepayment: $${amount}`);
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
        const isTestingMode = config.features.testingMode;
        
        if (isTestingMode) {
          console.log(`[GPS] 🧪 TESTING_MODE enabled for order ${shopifyOrderName}`);
          console.log(`[GPS] shouldSendToRealGps: ${shouldSendToRealGps}`);
          console.log(`[GPS] gpsOrderPayload: ${gpsOrderPayload ? 'built' : 'null'}`);
          console.log(`[GPS] warehouse: ${warehouseName}`);
          
          if (gpsOrderPayload) {
            console.log(`[GPS] Payload: ${JSON.stringify(gpsOrderPayload, null, 2)}`);
          }
        }

        // If GPS is enabled and we have a payload, make the real call
        if (shouldSendToRealGps && gpsOrderPayload) {
          try {
            const result = await gps.createOutboundOrder(
              gpsOrderPayload,
              warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
            );
            if (isTestingMode) {
              console.log(`[GPS] ✅ Real GPS call succeeded: ${JSON.stringify(result)}`);
            }
            return { type: "real", result };
          } catch (error) {
            if (error instanceof OutOfStockError) {
              console.log(`[GPS] ⚠️ Out of stock: ${error.message}`);
              return { type: "out_of_stock", error: error.message };
            }
            throw error;
          }
        }

        // Testing mode: return dummy response with payload details
        if (isTestingMode) {
          console.log(`[GPS] 🧪 TESTING_MODE: Returning dummy GPS response`);
          return {
            type: "dummy",
            message: "TESTING_MODE - GPS sync disabled or no payload",
            wouldHaveSent: gpsOrderPayload ? {
              platformOrderNo: gpsOrderPayload.platformOrderNo,
              whCode: gpsOrderPayload.whCode,
              productCount: gpsOrderPayload.productList?.length || 0,
            } : null,
          };
        }

        // Production: skip if GPS not enabled
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

