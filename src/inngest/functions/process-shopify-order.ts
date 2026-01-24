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

    await step.sleep("wait-for-d365-propagation", "5s");

    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const maxRetries = 3;
      const retryDelayMs = 3000;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await dynamics.confirmSalesOrder(salesOrderNumber, config.dynamics.dataAreaId);
          return;
        } catch (error) {
          const isNotFoundError =
            error instanceof Error && error.message.includes("does not exist");

          if (isNotFoundError && attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          } else {
            throw error;
          }
        }
      }
    });

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

    const gpsOrderPayload = await step.run("build-gps-payload", async () => {
      try {
        return toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
      } catch (error) {
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
          await step.sleep("wait-for-stock", `${config.delays.outOfStockRetryHours}h`);

          await step.run("retry-gps-after-oos", async () => {
            const retryPayload =
              gpsOrderPayload || toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
            return gps.createOutboundOrder(
              retryPayload,
              warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
            );
          });
        } else {
          throw error;
        }
      }
    }

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
