import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import type { ShopifyRefundPayload } from "../events";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "./utils/constants";

export const processRefund = inngest.createFunction(
  {
    id: "process-shopify-refund",
    name: "Process Shopify Refund",
    idempotency: "event.data.refundId",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.REFUND,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.REFUND,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.REFUND,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/refund.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, refundId, refundJson } = event.data;
    const refund = refundJson as ShopifyRefundPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    // 1. Get D365 Order to confirm it exists and get SalesOrderNumber
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order && config.features.enableDynamicsSync) {
      return {
        status: "no_d365_order",
        refundId,
        shopifyOrderId,
        message: "D365 order not found - refund cannot be processed",
      };
    }

    if (!d365Order && !config.features.enableDynamicsSync) {
      return { status: "skipped", reason: "Dynamics sync disabled" };
    }

    // 2. Get Shopify Order to determine warehouse (via shipping country)
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      return shopify.getOrder(shopifyOrderId);
    });

    // 3. Determine Warehouse and Refund SKU
    const warehouseInfo = await step.run("determine-warehouse-info", async () => {
      const countryCode = shopifyOrder.shipping_address?.country_code || "US";
      const warehouseName = warehouseHelper.determineWarehouse(countryCode);
      const refundSku = warehouseHelper.getRefundSku(warehouseName);
      const returnConfig = warehouseHelper.getReturnConfig(warehouseName);

      return {
        warehouseName,
        refundSku,
        returnConfig,
      };
    });

    // 4. Calculate Refund Amount (for the negative line price)
    // Note: In spock-store, price is positive, quantity is negative (-1).
    const refundAmount = await step.run("calculate-refund-amount", async () => {
      const totalAmount =
        refund.transactions
          ?.filter((tx) => tx.kind === "refund" && tx.status === "success")
          .reduce((sum, tx) => sum + parseFloat(tx.amount || "0"), 0) || 0;

      return totalAmount;
    });

    if (refundAmount <= 0) {
      return {
        status: "skipped",
        reason: "Refund amount is 0",
        refundId,
      };
    }

    // 5. Create Negative Sales Order Line
    const refundLine = await step.run("create-d365-refund-line", async () => {
      if (!config.features.enableDynamicsSync || !d365Order) {
        return { InventoryLotId: `SKIP-${refundId}`, status: "skipped" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      // Create negative line
      // Quantity -1, Price = Refund Amount
      const result = await dynamics.createSalesOrderLine({
        salesOrderNumber: d365Order.SalesOrderNumber!,
        dataAreaId,
        itemNumber: warehouseInfo.refundSku,
        quantity: -1,
        price: refundAmount,
      });

      return { ...result, status: "created" };
    });

    // 6. Fulfill the Negative Line (Post it)
    const fulfillment = await step.run("fulfill-refund-line", async () => {
      if (
        !config.features.enableDynamicsSync ||
        !d365Order ||
        refundLine.status === "skipped"
      ) {
        return { status: "skipped" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      await dynamics.createFulfilment({
        salesOrderNumber: d365Order.SalesOrderNumber!,
        dataAreaId,
        type: "return", // Special type for refund/return posting
        confirmedShippedDate: new Date().toISOString().split("T")[0],
        lines: [
          {
            itemNumber: warehouseInfo.refundSku,
            quantity: -1,
            shippingSiteId: warehouseInfo.returnConfig.shippingSiteId,
            shippingWarehouseId: warehouseInfo.returnConfig.shippingWarehouseId,
            shippingWarehouseLocationId:
              warehouseInfo.returnConfig.shippingWarehouseLocationId,
            lotId: refundLine.InventoryLotId,
            trackingNumber: "", // No tracking for financial refund
          },
        ],
      });

      return { status: "success" };
    });

    return {
      status: "success",
      refundId,
      shopifyOrderId,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      refundAmount,
      refundSku: warehouseInfo.refundSku,
      lotId: refundLine.InventoryLotId,
      processedAt: new Date().toISOString(),
    };
  }
);
