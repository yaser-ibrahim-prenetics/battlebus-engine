import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "./utils/constants";

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
  async ({ event, step }) => {
    const { shopifyOrderId, shopifyOrderName, cancelReason, orderJson } = event.data;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
      };
    }

    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }

      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order) {
      const gpsCancellation = await step.run("cancel-gps-order-only", async () => {
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
          };
        }
      });

      return {
        status: "partial",
        reason: "Order not found in D365",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
        gpsCancellation,
      };
    }

    const orderStatus = await step.run("check-d365-order-status", async () => {
      // TODO: Query D365 to check if order has packing slips/invoices
      return {
        isConfirmed: true,
        isShipped: false,
        canCancel: true,
      };
    });

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

    const d365Cancellation = await step.run("cancel-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return { status: "skipped", reason: "Dynamics sync disabled" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      if (orderStatus.isShipped) {
        // TODO: Implement D365 return order creation
        return {
          status: "not_implemented",
          action: "return_order_required",
          reason: "Order already shipped - return order needed",
        };
      }

      if (orderStatus.isConfirmed && !orderStatus.isShipped) {
        // Implement D365 order cancellation
        await dynamics.deleteSalesOrderHeaderV3(dataAreaId, d365Order.SalesOrderNumber!);
        return {
          status: "not_implemented",
          action: "cancel_order",
          dataAreaId,
          salesOrderNumber: d365Order.SalesOrderNumber,
          cancelReason: cancelReason || "Customer Request",
        };
      }

      return {
        status: "not_implemented",
        action: "delete_order",
        dataAreaId,
        salesOrderNumber: d365Order.SalesOrderNumber,
      };
    });

    const allCancelled =
      (gpsCancellation.status === "cancelled" || gpsCancellation.status === "skipped") &&
      (d365Cancellation.status === "not_implemented" || d365Cancellation.status === "skipped");

    return {
      status: allCancelled ? "success" : "partial",
      shopifyOrderId,
      shopifyOrderName,
      cancelReason,
      d365OrderNumber: d365Order.SalesOrderNumber,
      orderStatus,
      gpsCancellation,
      d365Cancellation,
      processedAt: new Date().toISOString(),
    };
  }
);
