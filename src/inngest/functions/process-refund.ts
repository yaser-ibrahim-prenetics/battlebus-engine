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
import { resolveD365OrderHeaderForRefundWithAudit } from "@/lib/services/d365-refund-order-resolution";
import { logRefundTraceLifecycle } from "@/lib/utils/d365-odata-trace";
import { hasCompletedRefundFlowLog, logFlowEvent } from "@/lib/services/supabase-flow-logs";
import { saveRefundOrderLine } from "@/lib/services/supabase-order-lines";
import { shopifyRefundCreatedByLoopReturns } from "@/lib/services/shopify-loop-refund-detection";

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
    const refundInitiator =
      (event.data as ShopifyRefundCreatedEvent["data"]).refundInitiator ?? "shopify_webhook";
    const refund = refundJson as ShopifyRefundPayload;
    const _flowStart = Date.now();

    const refundTrace = {
      refundId: String(refundId),
      shopifyOrderId: String(shopifyOrderId),
      inngestRunId: String(runId ?? ""),
      refundInitiator,
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

    const emitRefundConfirmation = (
      stepName: string,
      status: "running" | "completed" | "failed" | "skipped",
      payload?: Record<string, unknown>
    ) => {
      const row = {
        msg: "[Refund] confirmation",
        runId: String(runId || ""),
        refundId: String(refundId),
        shopifyOrderId: String(shopifyOrderId),
        step: stepName,
        status,
        ...payload,
      };
      if (status === "failed") {
        console.error(JSON.stringify(row));
      } else if (status === "skipped") {
        console.warn(JSON.stringify(row));
      } else {
        console.log(JSON.stringify(row));
      }
      logFlowEvent({
        flow: "refund",
        step: stepName,
        status,
        runId,
        shopifyOrderId: String(shopifyOrderId),
        payload: {
          refundId: String(refundId),
          ...payload,
        },
      });
    };

    if (config.features.dryRunMode) {
      emitRefundConfirmation("dry_run", "skipped", {
        reason: "dry_run_mode",
      });
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

    // Mirror spock-store `refund.processRefund`: Loop posts the financial refund via its own webhook
    // path first; Shopify's `refunds/create` repeats the signal. Skip D365 dupes using order events.
    if (refundInitiator === "shopify_webhook") {
      const isLoopBackedShopifyRefund = await step.run(
        "detect-loop-returns-shopify-refund-duplicate",
        async () => {
          if ((refund.transactions || []).length !== 1) {
            return false;
          }
          return shopifyRefundCreatedByLoopReturns(String(shopifyOrderId), refund);
        }
      );
      if (isLoopBackedShopifyRefund) {
        logRefundTraceLifecycle({
          ...refundTrace,
          phase: "process_refund_skipped_shopify_webhook_loop_duplicate",
        });
        emitRefundConfirmation("skipped_loop_returns_duplicate_shopify_webhook", "skipped", {
          reason: "refund_processed_from_loop_webhook_already",
          refundInitiator,
        });
        logFlowEvent({
          flow: "refund",
          step: "skipped_loop_returns_duplicate",
          status: "skipped",
          runId,
          shopifyOrderId: String(shopifyOrderId),
          payload: { refundId: String(refundId), refundInitiator },
        });
        return {
          status: "skipped",
          refundId,
          shopifyOrderId,
          reason:
            "Shopify refunds/create for Loop-backed refunds ignored — same as spock-store isLoopRefund (D365 line expected from Loop return.closed webhook).",
        };
      }
    }

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
    emitRefundConfirmation("d365_order_resolved", d365Order ? "completed" : "failed", {
      resolved: Boolean(d365Order),
      d365OrderNumber: d365Order?.SalesOrderNumber || null,
      dataAreaId: d365Order?.dataAreaId || null,
    });

    if (!d365Order && config.features.enableDynamicsSync) {
      if ((event.data as ShopifyRefundCreatedEvent["data"]).fromDrain) {
        return {
          status: "failed",
          refundId,
          shopifyOrderId,
          message: "D365 order not found after drain — refund permanently skipped",
        };
      }
      const ignoredRefund = await step.run("ignore-refund-no-processed-order", async () => {
        const payload = {
          ok: false,
          step: "ignore-refund-no-processed-order",
          refundId: String(refundId),
          shopifyOrderId: String(shopifyOrderId),
        } as const;
        console.log(
          JSON.stringify({
            msg: "[Refund] ignored_no_processed_order",
            ...refundTrace,
            ...payload,
          })
        );
        return payload;
      });
      logRefundTraceLifecycle({
        ...refundTrace,
        phase: "process_refund_ignored_no_processed_order",
        queuedRefundStepOutput: ignoredRefund,
      });
      console.log(
        `[Refund ${refundId}] Ignored for shopifyOrderId=${shopifyOrderId} — ` +
          `D365 header not resolved (order likely cancelled before processing)`
      );
      return {
        status: "ignored",
        refundId,
        shopifyOrderId,
        queuedRefund: undefined,
        reason:
          "Could not resolve D365 sales order. Refund ignored because order was not processed yet.",
      };
    }

    if (!d365Order && !config.features.enableDynamicsSync) {
      emitRefundConfirmation("dynamics_disabled", "skipped", {
        reason: "enableDynamicsSync=false",
      });
      return { status: "skipped", reason: "Dynamics sync disabled" };
    }

    // 3. Refund SKU + return sites: D365 legal entity comes from the header (`dataAreaId`).
    // Fulfillment profile (GPS vs STORD VATL, both often U001) comes from Hub `orders.warehouse`
    // when present — not shipping-country routing alone (US would wrongly pick GPS SKUs).
    const warehouseInfo = await step.run("determine-warehouse-info", async () => {
      let dataAreaId = (d365Order?.dataAreaId || config.dynamics.dataAreaId || "")
        .toUpperCase()
        .trim();
      if (!dataAreaId) {
        dataAreaId = warehouseHelper.getDefaultWarehouse().dataAreaId.toUpperCase();
      }
      const fulfillmentWarehouse = warehouseHelper.resolveRefundFulfillmentWarehouse(
        shopifyOrder.shipping_address?.country_code,
        d365Step.audit.supabaseLookup.warehouse
      );
      const fulfillmentProfile = warehouseHelper.getWarehouseConfig(fulfillmentWarehouse);
      const refundSku = warehouseHelper.getRefundSku(fulfillmentWarehouse, dataAreaId);

      return {
        dataAreaId,
        warehouseName: fulfillmentWarehouse,
        refundSku,
        returnConfig: fulfillmentProfile.return,
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

    emitRefundConfirmation("refund_amount_resolved", "completed", {
      refundAmount,
      refundAmountUsd,
      sourceCurrency: (shopifyOrder.currency || "USD").toUpperCase(),
      exchangeRateSource: exchangeRateInfo?.source || null,
      txCount: Array.isArray(refund.transactions) ? refund.transactions.length : 0,
      refundLineItemsCount: Array.isArray(refund.refund_line_items)
        ? refund.refund_line_items.length
        : 0,
      adjustmentsCount: Array.isArray(refund.order_adjustments) ? refund.order_adjustments.length : 0,
    });

    if (refundAmountUsd <= 0) {
      emitRefundConfirmation("skip_zero_refund_amount", "skipped", {
        reason: "refund_amount_usd_le_zero",
        refundAmount,
        refundAmountUsd,
      });
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
      emitRefundConfirmation("d365_refund_line_created", "completed", {
        d365OrderNumber: d365Order?.SalesOrderNumber || null,
        refundSku: warehouseInfo.refundSku,
        refundAmountUsd,
        lotId: refundLine.InventoryLotId,
      });
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

      // Align Supabase `order_lines` with D365 as soon as the negative line exists
      // (fulfilment / credit note updated in a second upsert below).
      const draftSave = await step.run("save-refund-order-line-draft", async () =>
        saveRefundOrderLine({
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
          is_fulfilled_to_dynamics: false,
          credit_note_number: null,
          exchange_rate: exchangeRateInfo?.rate ?? null,
          exchange_rate_source: exchangeRateInfo?.source ?? null,
          source_currency: exchangeRateInfo?.from ?? (shopifyOrder.currency || "USD").toUpperCase(),
        })
      );
      if (draftSave.ok) {
        emitRefundConfirmation("order_lines_refund_draft_saved", "completed", {
          phase: "draft",
          degraded: Boolean(draftSave.degraded),
        });
      } else {
        emitRefundConfirmation("order_lines_refund_draft_saved", "failed", {
          phase: "draft",
          reason: draftSave.reason,
          message: "message" in draftSave ? draftSave.message : undefined,
        });
      }
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
    emitRefundConfirmation(
      "d365_refund_fulfilment",
      fulfillment.status === "success" ? "completed" : "skipped",
      {
        d365OrderNumber: d365Order?.SalesOrderNumber || null,
        lotId: refundLine.InventoryLotId,
        refundSku: warehouseInfo.refundSku,
      }
    );

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

    // 7b. Final upsert: fulfilment + credit note on the same `order_lines` row
    // (draft row was written right after D365 line creation).
    if (refundLine.status === "created" && d365Order) {
      const finalSave = await step.run("save-refund-order-line-final", async () =>
        saveRefundOrderLine({
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
        })
      );
      if (finalSave.ok) {
        emitRefundConfirmation("order_lines_refund_final_saved", "completed", {
          phase: "final",
          degraded: Boolean(finalSave.degraded),
        });
      } else {
        emitRefundConfirmation("order_lines_refund_final_saved", "failed", {
          phase: "final",
          reason: finalSave.reason,
          message: "message" in finalSave ? finalSave.message : undefined,
        });
      }
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
    emitRefundConfirmation("refund_pipeline_done", "completed", {
      d365OrderNumber: d365Order?.SalesOrderNumber || null,
      refundAmountUsd,
      creditNoteNumber: creditNoteNumber || null,
      invoiceResult: invoiceResult.status,
      durationMs: Date.now() - _flowStart,
    });
    return result;
  }
);
