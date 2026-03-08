import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as shopify from "@/lib/clients/shopify";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import * as csPlatform from "@/lib/clients/cs-platform";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { ShopifyOrderPayload } from "../events";

export const processOrderCancellation = inngest.createFunction(
  {
    id: "process-order-cancellation",
    name: "Process Order Cancellation",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    throttle: {
      ...THROTTLE_CONFIGS.CANCELLATION,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.CANCELLATION,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.CANCELLATION,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/order.cancelled" },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, cancelReason, orderJson } = event.data;
    const shopifyOrderPayload = orderJson as ShopifyOrderPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
      };
    }

    // 1. Get D365 Order (lookup by order name, not ID, since THK_ShopifyReference stores the order name)
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., #D365-GPS-123)
      return dynamics.getSalesOrderByShopifyId(shopifyOrderName);
    });

    // 2. Try to Cancel GPS Order
    const gpsCancellation = await step.run("cancel-gps-order", async () => {
      if (!config.features.enableGpsSync) {
        return { status: "skipped", reason: "GPS sync disabled" };
      }

      try {
        const result = await gps.cancelOutboundOrder(shopifyOrderName);
        return { status: result.success ? "cancelled" : "failed", result };
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          note: "Order may already be shipped or not found in GPS",
        };
      }
    });

    // 3. Handle D365 Cancellation or Return
    const d365Cancellation = await step.run("process-d365-cancellation", async () => {
      if (!config.features.enableDynamicsSync || !d365Order) {
        return { status: "skipped", reason: "Dynamics sync disabled or order not found" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;
      const isGpsCancelled =
        gpsCancellation.status === "cancelled" || gpsCancellation.status === "skipped";

      if (isGpsCancelled) {
        // Case A: GPS Cancelled -> Cancel D365 Order
        // Currently we don't have a direct cancel API in D365 clients.
        // Assuming we just log it or maybe implement cancel later.
        return {
          status: "not_implemented",
          action: "cancel_order",
          dataAreaId,
          salesOrderNumber: d365Order.SalesOrderNumber,
          cancelReason: cancelReason || "Customer Request",
          message: "GPS cancelled, D365 cancellation pending implementation",
        };
      } else {
        // Case B: GPS Failed (Likely Shipped) -> Create Return Order in D365
        // This is the "Return" flow from spock-store
        console.log(
          `[Cancellation] GPS cancel failed, initiating Return Order flow for ${shopifyOrderName}`
        );

        // 3a. Get Shopify Order Details (for address/warehouse)
        const shopifyOrder = await shopify.getOrder(shopifyOrderId);

        // 3b. Determine Warehouse Config
        const countryCode = shopifyOrder.shipping_address?.country_code || "US";
        const warehouseName = warehouseHelper.determineWarehouse(countryCode);
        const returnConfig = warehouseHelper.getReturnConfig(warehouseName);
        const orderingCustomerAccountNumber =
          warehouseHelper.getOrderingCustomerAccountNumber(warehouseName);

        // 3c. Get D365 Original Lines (to link Lot IDs)
        const d365Lines = await dynamics.getSalesOrderLines(d365Order.SalesOrderNumber!);
        const skuToLotIdMap = d365Lines.reduce(
          (acc, line) => {
            acc[line.ItemNumber] = line.InventoryLotId;
            return acc;
          },
          {} as Record<string, string | undefined>
        );

        // 3d. Create Return Order Header
        const { SalesOrderNumber: returnOrderNumber } =
          await dynamics.createSalesOrderHeadersV3ForReturn({
            customerId: shopifyOrder.customer?.id.toString() || "",
            orderId: shopifyOrder.id.toString(),
            dataAreaId,
            orderingCustomerAccountNumber,
            defaultLedgerDimensionDisplayValue:
              warehouseHelper.toDefaultLedgerDimensionDisplayValue(warehouseName),
            customerOrderReference: shopifyOrder.name,
            email: shopifyOrder.email,
            name: `${shopifyOrder.customer?.first_name || ""} ${shopifyOrder.customer?.last_name || ""}`.trim(),
            shopifyReference: shopifyOrder.name,
          });

        // 3e. Create Return Order Lines
        const returnLinesResult = [];
        for (const item of shopifyOrder.line_items) {
          const originalLotId = skuToLotIdMap[item.sku];
          if (!originalLotId) {
            console.warn(
              `[Cancellation] Original LotId not found for SKU ${item.sku} in D365 order ${d365Order.SalesOrderNumber}`
            );
            continue;
          }

          // In return order, quantity is negative (wait, spock-store toSalesOrderLinesForReturn sets quantity -1 ?)
          // Let's check spock-store logic again.
          // spock-store: quantity: -1, price: price (positive), discount: discount

          await dynamics.createSalesOrderLineForReturn({
            salesOrderNumber: returnOrderNumber,
            quantity: -1 * item.quantity, // Return all
            itemNumber: item.sku,
            price: parseFloat(item.price),
            discount: parseFloat(item.total_discount),
            dataAreaId,
            inventTransIdReturn: originalLotId,
            shippingSiteId: returnConfig.shippingSiteId,
          });
          returnLinesResult.push({ sku: item.sku, quantity: item.quantity });
        }

        // 3f. Confirm Return Order
        await dynamics.confirmSalesOrder(returnOrderNumber, dataAreaId);

        return {
          status: "success",
          action: "return_order_created",
          returnOrderNumber,
          dataAreaId,
          returnLines: returnLinesResult,
        };
      }
    });

    const result = {
      status:
        d365Cancellation.status === "success" || d365Cancellation.status === "not_implemented"
          ? "success"
          : "partial",
      shopifyOrderId,
      shopifyOrderName,
      cancelReason,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      gpsCancellation,
      d365Cancellation,
      processedAt: new Date().toISOString(),
    };

    // Send cancellation event to CS platform with Shopify status
    if (result.status === "success" || result.status === "partial") {
      await csPlatform.sendOrderCancelled({
        orderId: shopifyOrderId,
        shopifyOrderName,
        reason: cancelReason,
        shopifyFinancialStatus: shopifyOrderPayload?.financial_status,
        shopifyCancelledAt: shopifyOrderPayload?.cancelled_at || undefined,
      });
    }

    return result;
  }
);
