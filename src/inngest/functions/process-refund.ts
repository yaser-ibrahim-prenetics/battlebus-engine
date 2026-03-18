import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import * as exchangeHelper from "@/lib/helpers/exchange";
import * as csPlatform from "@/lib/clients/cs-platform";
import type { ShopifyRefundPayload } from "../events";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { storePendingAction } from "@/lib/services/pending-actions";

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
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, refundId, refundJson } = event.data;
    const refund = refundJson as ShopifyRefundPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    // 1. Get Shopify Order first (needed for order name lookup)
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      return shopify.getOrder(shopifyOrderId);
    });

    // 2. Get D365 Order to confirm it exists and get SalesOrderNumber
    // Use order name since THK_ShopifyReference stores the order name (e.g., #D365-GPS-123)
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrder.name);
    });

    if (!d365Order && config.features.enableDynamicsSync) {
      if ((event.data as any).fromDrain) {
        return {
          status: "failed",
          refundId,
          shopifyOrderId,
          message: "D365 order not found after drain — refund permanently skipped",
        };
      }
      await step.run("store-pending-refund", async () => {
        await storePendingAction(shopifyOrderId, {
          action: "refund",
          eventName: "shopify/refund.created",
          eventData: event.data,
          createdAt: new Date().toISOString(),
        });
      });
      console.log(
        `[PendingActions] Deferred refund ${refundId} for shopifyOrderId=${shopifyOrderId} — D365 order not yet created`
      );
      return {
        status: "deferred",
        refundId,
        shopifyOrderId,
        reason: "D365 order not yet created, refund queued for replay",
      };
    }

    if (!d365Order && !config.features.enableDynamicsSync) {
      return { status: "skipped", reason: "Dynamics sync disabled" };
    }

    // 3. Determine Warehouse and Refund SKU
    const warehouseInfo = await step.run("determine-warehouse-info", async () => {
      const dataAreaId = (d365Order?.dataAreaId || config.dynamics.dataAreaId || "").toUpperCase();
      const countryCode = shopifyOrder.shipping_address?.country_code || "US";
      const warehouseName = warehouseHelper.determineWarehouse(countryCode);
      const refundSku = warehouseHelper.getRefundSku(warehouseName, dataAreaId);
      const returnConfig = warehouseHelper.getReturnConfig(warehouseName);

      return {
        dataAreaId,
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

    // 4b. Convert refund amount to USD if order is in a different currency
    const { refundAmountUsd, exchangeRateInfo } = await step.run(
      "convert-refund-currency",
      async () => {
        const orderCurrency = (shopifyOrder.currency || "USD").toUpperCase();

        if (orderCurrency === "USD") {
          return {
            refundAmountUsd: refundAmount,
            exchangeRateInfo: null,
          };
        }

        // Try to extract exchange rate from Shopify transactions
        const transactions = shopifyOrder.transactions || refund.transactions || [];
        let exchangeRate = exchangeHelper.extractExchangeRateFromTransactions(
          transactions,
          "USD"
        );

        // Fall back to static rates if transaction-based extraction fails
        if (!exchangeRate) {
          exchangeRate = exchangeHelper.getFallbackRate(orderCurrency, "USD");
        }

        const convertedAmount = exchangeHelper.convertToShopCurrency(
          refundAmount,
          orderCurrency,
          exchangeRate
        );

        console.log(
          `[Refund ${refundId}] Currency conversion: ${refundAmount} ${orderCurrency} → ${convertedAmount} USD` +
            ` (rate: ${exchangeRate?.rate ?? "1:1 fallback"}, source: ${exchangeRate?.source ?? "none"})`
        );

        return {
          refundAmountUsd: convertedAmount,
          exchangeRateInfo: exchangeRate
            ? {
                from: exchangeRate.from,
                to: exchangeRate.to,
                rate: exchangeRate.rate,
                source: exchangeRate.source,
              }
            : null,
        };
      }
    );

    if (refundAmountUsd <= 0) {
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
        price: refundAmountUsd,
      });

      return { ...result, status: "created" };
    });

    // 6. Fulfill the Negative Line (Post it)
    const fulfillment = await step.run("fulfill-refund-line", async () => {
      if (!config.features.enableDynamicsSync || !d365Order || refundLine.status === "skipped") {
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
            shippingWarehouseLocationId: warehouseInfo.returnConfig.shippingWarehouseLocationId,
            lotId: refundLine.InventoryLotId,
            trackingNumber: "", // No tracking for financial refund
          },
        ],
      });

      return { status: "success" };
    });

    const result = {
      status: "success",
      refundId,
      shopifyOrderId,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      refundAmount,
      refundAmountUsd,
      exchangeRateInfo,
      refundSku: warehouseInfo.refundSku,
      lotId: refundLine.InventoryLotId,
      processedAt: new Date().toISOString(),
    };

    // Determine if this is a full or partial refund based on Shopify order total
    const orderTotal = parseFloat(shopifyOrder.total_price || "0");
    const refundType = refundAmountUsd >= orderTotal ? "full" : "partial";

    // Send refund event to CS platform with financial status
    await csPlatform.sendOrderRefunded({
      orderId: shopifyOrderId,
      shopifyOrderName: shopifyOrder.name || shopifyOrderId,
      amount: refundAmountUsd.toString(),
      reason: "Refund processed",
      shopifyFinancialStatus: shopifyOrder.financial_status,
      refundType,
    });

    return result;
  }
);
