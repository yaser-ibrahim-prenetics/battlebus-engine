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
import { hasCompletedRefundFlowLog, logFlowEvent } from "@/lib/services/supabase-flow-logs";
import { saveRefundOrderLine } from "@/lib/services/supabase-order-lines";

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
    const _flowStart = Date.now();

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

    logFlowEvent({
      flow: "refund",
      step: "start",
      status: "started",
      runId,
      shopifyOrderId: String(shopifyOrderId),
      payload: { refundId: String(refundId) },
    });

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    // 0. Cross-run dedupe guard.
    //
    // Inngest's `idempotency: "event.data.refundId"` covers same-event retries, but
    // a Hub-triggered refund race followed by Shopify's webhook can still produce two
    // distinct events sharing the same `refundId`. Mirror spock-store's per-line
    // `shopifyLineItemId` check by looking at `flow_logs` for a prior completed
    // emit for this refund.
    const alreadyProcessed = await step.run("refund-dedupe-check", async () => {
      return hasCompletedRefundFlowLog(String(refundId));
    });
    if (alreadyProcessed) {
      console.log(
        `[Refund ${refundId}] Skipped — prior completed refund flow log exists for this refundId`
      );
      logRefundTraceLifecycle({
        ...refundTrace,
        phase: "process_refund_already_processed",
      });
      logFlowEvent({
        flow: "refund",
        step: "already_processed",
        status: "skipped",
        runId,
        shopifyOrderId: String(shopifyOrderId),
        payload: { refundId: String(refundId) },
      });
      return {
        status: "already_processed",
        refundId,
        shopifyOrderId,
        reason: "Prior completed refund flow log exists for this refundId",
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
      let dataAreaId = (d365Order?.dataAreaId || config.dynamics.dataAreaId || "")
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

    // 4b. Convert refund amount to USD if order is in a different currency.
    //
    // Priority (matches spock-store's convertToUsd):
    //   1. The refund transaction's own `receipt.balance_transaction.exchange_rate`
    //      (authoritative Stripe/Shopify FX rate actually applied to this refund).
    //   2. Pair-based derivation from two differing-currency transactions on the order.
    //   3. Hand-maintained static fallback table.
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

        let exchangeRate = exchangeHelper.extractExchangeRateFromRefundReceipt(refund, "USD");

        if (!exchangeRate) {
          const transactions = shopifyOrder.transactions || refund.transactions || [];
          exchangeRate = exchangeHelper.extractExchangeRateFromTransactions(transactions, "USD");
        }

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

    // Emit the dedupe anchor immediately after the negative line is created so that
    // any duplicate `refundId` event landing later can short-circuit in step 0,
    // even if the current run fails before the `done` log is written.
    if (refundLine.status === "created") {
      logFlowEvent({
        flow: "refund",
        step: "refund_line_created",
        status: "completed",
        runId,
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName: shopifyOrder.name,
        d365OrderNumber: d365Order?.SalesOrderNumber,
        payload: {
          refundId: String(refundId),
          refundSku: warehouseInfo.refundSku,
          refundAmountUsd,
          inventoryLotId: refundLine.InventoryLotId,
        },
      });
    }

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

    // 7. Post Return Order Invoice (opt-in).
    //
    // In the standard THK tenant a `type: "return"` fulfilment already generates
    // the D365 credit note, matching spock-store's flow (which never calls this
    // endpoint). Calling `postReturnOrderInvoice` in those tenants is redundant
    // and can double-post. Only invoke when explicitly enabled via
    // `features.enableReturnInvoicePosting` (env: `ENABLE_RETURN_INVOICE_POSTING=true`).
    const invoiceResult = await step.run("post-return-invoice", async () => {
      if (!config.features.enableDynamicsSync || !d365Order || fulfillment.status === "skipped") {
        return { status: "skipped" };
      }

      if (!config.features.enableReturnInvoicePosting) {
        console.log(
          `[Refund ${refundId}] Skipping postReturnOrderInvoice — credit note expected via ` +
            `return fulfilment (enable ENABLE_RETURN_INVOICE_POSTING=true to force the explicit call)`
        );
        return {
          status: "skipped",
          reason: "return_invoice_disabled",
        };
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

    // 7b. Persist the D365 refund line to Supabase `order_lines` so the Hub's
    // order-detail view can render it alongside the product / service lines
    // (and surface credit note + FX rate + source currency). Best-effort: failures
    // here do not roll back the D365-side refund posting, which has already
    // succeeded at this point.
    if (refundLine.status === "created" && d365Order) {
      await step.run("save-refund-order-line", async () => {
        return saveRefundOrderLine({
          shopify_order_id: String(shopifyOrderId),
          shopify_order_name: shopifyOrder.name ?? null,
          refund_id: String(refundId),
          refund_sku: warehouseInfo.refundSku,
          d365_sales_order_number: d365Order?.SalesOrderNumber ?? null,
          data_area_id:
            (d365Order?.dataAreaId || warehouseInfo.dataAreaId || config.dynamics.dataAreaId) ??
            null,
          refund_amount_usd: refundAmountUsd,
          dynamics_inventory_lot_id: refundLine.InventoryLotId ?? null,
          is_fulfilled_to_dynamics: fulfillment.status === "success",
          credit_note_number: creditNoteNumber ?? null,
          exchange_rate: exchangeRateInfo?.rate ?? null,
          exchange_rate_source: exchangeRateInfo?.source ?? null,
          source_currency: exchangeRateInfo?.from ?? (shopifyOrder.currency || "USD").toUpperCase(),
        });
      });
    }

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

    logFlowEvent({
      flow: "refund",
      step: "done",
      status: "completed",
      runId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName: shopifyOrder.name,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      durationMs: Date.now() - _flowStart,
      payload: { refundId: String(refundId), refundAmountUsd, creditNoteNumber },
    });
    return result;
  }
);
