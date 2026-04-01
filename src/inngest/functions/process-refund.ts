import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import * as exchangeHelper from "@/lib/helpers/exchange";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import type { ShopifyRefundCreatedEvent, ShopifyRefundPayload } from "../events";
import { computeRefundAmountShopifyPresentment } from "@/lib/utils/shopify-refund-amount";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { storePendingAction } from "@/lib/services/pending-actions";
import { resolveD365OrderHeaderForRefundWithAudit } from "@/lib/services/d365-refund-order-resolution";
import { logRefundTraceLifecycle } from "@/lib/utils/d365-odata-trace";

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
    triggers: [{ event: "shopify/refund.created" }],
  },
  async ({ event, step, runId }) => {
    const { shopifyOrderId, refundId, refundJson } = event.data;
    const refund = refundJson as ShopifyRefundPayload;

    const refundTrace = {
      refundId: String(refundId),
      shopifyOrderId: String(shopifyOrderId),
      inngestRunId: String(runId ?? ""),
    };

    logRefundTraceLifecycle({
      ...refundTrace,
      phase: "process_refund_start",
      fromDrain: Boolean((event.data as ShopifyRefundCreatedEvent["data"]).fromDrain),
    });

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    // 1. Get Shopify Order first (needed for order name lookup)
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      const order = await shopify.getOrder(shopifyOrderId);
      logRefundTraceLifecycle({
        ...refundTrace,
        phase: "shopify_order_loaded",
        orderName: order?.name ?? null,
        orderNumericId: order?.id != null ? String(order.id) : null,
      });
      return order;
    });

    // 2. Get D365 Order to confirm it exists and get SalesOrderNumber
    // THK_ShopifyReference is set from Shopify order `name` at header creation (see toD365SalesOrderHeaderV3).
    // Try shipping-country-routed + all configured data areas (like spock-store finding the SO regardless
    // of which entity row it lives under) and both `#IM8-123` / `IM8-123` variants — a single default
    // dataAreaId alone can miss US vs UK legal entities.
    const d365Step = await step.run("get-d365-order", async () => {
      const { header, audit } = await resolveD365OrderHeaderForRefundWithAudit({
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrder,
        trace: refundTrace,
      });
      logRefundTraceLifecycle({
        ...refundTrace,
        phase: "get_d365_order_step_result",
        resolved: Boolean(header),
        salesOrderNumber: header?.SalesOrderNumber ?? null,
        headerDataAreaId: header?.dataAreaId ?? null,
      });
      /**
       * Inngest serializes step output — `audit` explains Supabase + OData attempts (no separate step).
       * `header` is null when deferred; do not expect bare `null` as the whole step output anymore.
       */
      return {
        resolved: Boolean(header),
        audit,
        header,
      };
    });
    const d365Order = d365Step.header;

    if (!d365Order && config.features.enableDynamicsSync) {
      if ((event.data as ShopifyRefundCreatedEvent["data"]).fromDrain) {
        return {
          status: "failed",
          refundId,
          shopifyOrderId,
          message: "D365 order not found after drain — refund permanently skipped",
        };
      }
      const queuedRefund = await step.run("queue-refund-pending-action", async () => {
        await storePendingAction(shopifyOrderId, {
          action: "refund",
          eventName: "shopify/refund.created",
          eventData: event.data,
          createdAt: new Date().toISOString(),
        });
        const payload = {
          ok: true,
          step: "queue-refund-pending-action",
          refundId: String(refundId),
          shopifyOrderId: String(shopifyOrderId),
        } as const;
        console.log(
          JSON.stringify({
            msg: "[PendingActions] refund_deferred_pending_action_stored",
            ...refundTrace,
            ...payload,
          })
        );
        return payload;
      });
      logRefundTraceLifecycle({
        ...refundTrace,
        phase: "process_refund_deferred",
        queuedRefundStepOutput: queuedRefund,
      });
      console.log(
        `[PendingActions] Deferred refund ${refundId} for shopifyOrderId=${shopifyOrderId} — ` +
          `D365 header not resolved (Vercel: search logs for RefundTraceLifecycle, D365ODataTrace, [D365Resolve], [SupabaseOrderLookup])`
      );
      return {
        status: "deferred",
        refundId,
        shopifyOrderId,
        queuedRefund,
        reason:
          "Could not resolve D365 sales order (Supabase d365_order_number + OData). Refund POST to D365 was not run. Check Vercel logs; ensure Hub row + SUPABASE_* on Bus; pending action queued if Hub matched the order id.",
      };
    }

    if (!d365Order && !config.features.enableDynamicsSync) {
      return { status: "skipped", reason: "Dynamics sync disabled" };
    }

    // 3. Refund SKU + return sites: legal entity comes from the D365 header (dataAreaId).
    // Return warehouse / location must match that entity’s profile — not shipping country alone.
    const warehouseInfo = await step.run("determine-warehouse-info", async () => {
      let dataAreaId = (
        d365Order?.dataAreaId ||
        config.dynamics.dataAreaId ||
        ""
      )
        .toUpperCase()
        .trim();
      if (!dataAreaId) {
        dataAreaId = warehouseHelper.getDefaultWarehouse().dataAreaId.toUpperCase();
      }
      const countryCode = shopifyOrder.shipping_address?.country_code || "US";
      const warehouseName = warehouseHelper.determineWarehouse(countryCode);
      const areaProfile = warehouseHelper.getWarehouseConfigForDataAreaId(dataAreaId);
      const refundSku = warehouseHelper.getRefundSku(warehouseName, dataAreaId);

      return {
        dataAreaId,
        warehouseName,
        refundSku,
        returnConfig: areaProfile.return,
      };
    });

    // 4. Calculate Refund Amount (for the negative line price)
    // Note: In spock-store, price is positive, quantity is negative (-1).
    const refundAmount = await step.run("calculate-refund-amount", async () => {
      return computeRefundAmountShopifyPresentment(refund);
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

    // 7. Post Return Order Invoice (generates D365 credit note)
    const invoiceResult = await step.run("post-return-invoice", async () => {
      if (!config.features.enableDynamicsSync || !d365Order || fulfillment.status === "skipped") {
        return { status: "skipped" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      try {
        const result = await dynamics.postReturnOrderInvoice({
          salesOrderNumber: d365Order.SalesOrderNumber!,
          dataAreaId,
          invoiceDate: new Date(),
        });
        if (result.skipped) {
          console.warn(
            `[Refund ${refundId}] D365 return invoice step skipped: ${result.reason || "unknown"}`
          );
          return {
            status: "skipped",
            reason: result.reason || "unknown",
          };
        }
        console.log(
          `[Refund ${refundId}] D365 return invoice posted: credit note ${result.creditNoteNumber}`
        );
        return {
          status: "success",
          creditNoteNumber: result.creditNoteNumber,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Refund ${refundId}] D365 return invoice failed: ${errorMsg}`);
        await slack
          .sendWarningMessage(
            "dynamics",
            `[Refund] postReturnOrderInvoice failed for ${d365Order.SalesOrderNumber} (refund ${refundId}): ${errorMsg}`
          )
          .catch(() => {});
        return { status: "error", error: errorMsg };
      }
    });

    const creditNoteNumber =
      invoiceResult.status === "success" && "creditNoteNumber" in invoiceResult
        ? invoiceResult.creditNoteNumber
        : undefined;

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
      creditNoteNumber,
      invoiceResult: invoiceResult.status,
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
