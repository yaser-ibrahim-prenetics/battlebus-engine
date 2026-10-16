// ============================================================================
// SUBSCRIPTION RENEWAL ORDER PROCESSING (Skio / Prive)
// ============================================================================
// Handles orders where source_name === 'subscription_contract'
// These get higher concurrency, faster retries, and tag-wait logic.
//
// Key differences from process-shopify-order:
//   1. Skips the 5-minute delay (subscription orders are pre-validated)
//   2. Checks for subscription reward tags — reschedules for up to 5 min if missing (configurable)
//   3. Higher concurrency limit (Skio can burst 50+ orders at once)
//   4. Maps refill SKUs to their Dynamics counterparts

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import { setGpsOrderMetafield, getOrder as shopifyGetOrder } from "@/lib/clients/shopify";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toOrderLineRecords,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
} from "@/lib/transformers/order";
import {
  saveOrderLines,
  type OrderLineRecord,
  type SaveOrderLinesResult,
} from "@/lib/services/order-lines";
import { validateOrderCompletely } from "@/lib/utils/validation";
import {
  THROTTLE_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  retryWithBackoff,
  SUBSCRIPTION_TAG_WAIT_MINUTES,
  SUBSCRIPTION_TAG_WAIT_WARN_ENABLED,
} from "@/lib/utils/constants";
import { type ShopifyOrderPayload } from "../events";
import { SlackChannelEnum } from "@/lib/types/slack";
import { NonRetriableError } from "inngest";
import { logFlowEvent, flushAll as flushFlowLogs } from "@/lib/services/flow-logs";
import { loadSaudiShortAddress } from "./process-shopify-order/saudi-short-address";
import { enqueueOpenAiAdsConversion } from "@/lib/services/openai-ads-conversions";
import {
  isD365ItemNotFoundError,
  isNonRetryableOrderError,
  isRefillOrder,
  isServiceSkuItemNumber,
} from "./process-subscription-order/helpers";
import { determineSubscriptionWarehouse } from "./process-subscription-order/routing";

// ============================================================================
// FUNCTION DEFINITION
// ============================================================================

export const processSubscriptionOrder = inngest.createFunction(
  {
    id: "process-subscription-order",
    name: "Process Subscription Renewal Order (Skio)",
    idempotency: "event.data.shopifyOrderId",
    // Higher retries: subscription failures are customer-impacting
    retries: RETRY_CONFIGS.CRITICAL,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    // Higher concurrency: Skio can burst many renewals at once
    concurrency: [
      {
        limit: parseInt(process.env.CONCURRENCY_SUBSCRIPTION || "10", 10),
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
    triggers: [{ event: "shopify/subscription.renewed" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const {
      shopifyOrderId: rawShopifyOrderId,
      shopifyOrderName,
      subscriptionContractId,
      shopifyStore,
    } = event.data;
    const isRerun =
      Boolean(event.data.originalShopifyOrderId) ||
      String(rawShopifyOrderId || "").includes("-rerun-");
    // Reruns append "-rerun-<ts>" to shopifyOrderId for idempotency.
    // Always use canonical Shopify order ID for Shopify API calls and persistence.
    const shopifyOrderId = String(
      event.data.originalShopifyOrderId || String(rawShopifyOrderId || "").split("-rerun-")[0]
    );
    let order = event.data.orderJson as ShopifyOrderPayload;

    const _runId = String(runId ?? "");
    const inngestIdempotencyKey = `shopify-subscription-renewed-${shopifyOrderId}`;

    logFlowEvent({
      flow: "subscription_renewal",
      step: "start",
      status: "started",
      runId: _runId || undefined,
      shopifyOrderId,
      shopifyOrderName,
      payload: { subscriptionContractId },
    });

    // Durable start time for processing_summary (must live inside step.run for Inngest replays).
    const flowStartedAt = await step.run("subscription-flow-started-at", async () => Date.now());

    console.log(`[Subscription] ========================================`);
    console.log(
      `[Subscription] Processing renewal: ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"})`
    );

    // =========================================================================
    // STEP 1: Re-fetch order to get the latest tags (Skio applies tags async)
    // =========================================================================
    const refreshedOrder = await step.run("refetch-order-for-tags", async () => {
      const fresh = await shopifyGetOrder(shopifyOrderId, shopifyStore);
      console.log(
        `[Subscription] Refetched ${shopifyOrderName}. Tags: "${fresh.tags || "(none)"}"`
      );
      return fresh;
    });
    order = refreshedOrder as ShopifyOrderPayload;

    // =========================================================================
    // STEP 2: Tag-wait — if refill order but subscription tag missing, wait
    // =========================================================================
    const tagsMissing = await step.run("check-subscription-tags", async () => {
      return isRefillOrder(order);
    });

    if (tagsMissing && !isRerun) {
      console.log(
        `[Subscription] ⚠️  Order ${shopifyOrderName} is a refill but missing subscription tag. Waiting ${SUBSCRIPTION_TAG_WAIT_MINUTES} min for Skio to apply tags...`
      );

      // Wait for the tag to appear (Skio applies tags within seconds, 5min default is sufficient)
      await step.sleep("wait-for-subscription-tags", `${SUBSCRIPTION_TAG_WAIT_MINUTES}m`);

      // Re-fetch once more
      const reOrderAfterWait = await step.run("refetch-after-tag-wait", async () => {
        const fresh = await shopifyGetOrder(shopifyOrderId, shopifyStore);
        console.log(
          `[Subscription] Post-wait refetch ${shopifyOrderName}. Tags: "${fresh.tags || "(none)"}"`
        );
        return fresh;
      });
      order = reOrderAfterWait as ShopifyOrderPayload;

      // Still missing — alert and continue processing (do not block indefinitely)
      if (isRefillOrder(order)) {
        if (SUBSCRIPTION_TAG_WAIT_WARN_ENABLED) {
          await step.run("alert-missing-subscription-tags", async () => {
            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `[Subscription] Subscription tag still missing after ${SUBSCRIPTION_TAG_WAIT_MINUTES}min for ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"}). Proceeding without tag — check Skio webhook delivery.`
            );
          });
        }
        console.warn(
          `[Subscription] Tag still missing after ${SUBSCRIPTION_TAG_WAIT_MINUTES}min for ${shopifyOrderName}. Proceeding anyway.`
        );
      }
    } else if (tagsMissing && isRerun) {
      console.log(
        `[Subscription] Rerun detected for ${shopifyOrderName}; skipping subscription tag wait delay`
      );
    }

    // =========================================================================
    // STEP 3: Validate order
    // =========================================================================
    const validation = await step.run("validate-subscription-order", async () => {
      return validateOrderCompletely(order, shopifyOrderId, shopifyOrderName);
    });

    if (!validation.valid && !validation.skip) {
      console.log(
        `[Subscription] ⏭️  Skipping ${shopifyOrderName}: ${validation.status} — ${validation.reason}`
      );
      return { status: validation.status, reason: validation.reason };
    }

    // =========================================================================
    // STEP 4: Determine warehouse and dataAreaId strictly from Battle Hub
    // location settings. No country/config fallback.
    // =========================================================================
    const warehouseInfo = await determineSubscriptionWarehouse({
      step,
      order,
      shopifyOrderId,
      shopifyOrderName,
    });

    const { dataAreaId, warehouseName } = warehouseInfo;
    const saudiShortAddress = await loadSaudiShortAddress({
      step,
      order,
      shopifyOrderId,
      shopifyStore,
    });

    // =========================================================================
    // STEP 5: Create D365 Sales Order Header (check for existing first)
    // =========================================================================
    const existingD365Order = await step.run("check-existing-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return null;
      try {
        return await dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
      } catch {
        return null;
      }
    });

    if (existingD365Order) {
      console.log(
        `[Subscription] ✅ D365 order already exists for ${shopifyOrderName}: ${existingD365Order.SalesOrderNumber}`
      );
      await step.run("prepay-existing-d365-order", async () => {
        if (!config.features.enableDynamicsSync) return { status: "skipped" };
        const prepayAmount = calculatePrepaymentAmount(order);
        if (prepayAmount <= 0) return { status: "skipped", reason: "zero amount" };
        await retryWithBackoff(
          () => dynamics.createPrepayment(existingD365Order.SalesOrderNumber, dataAreaId),
          {
            label: `D365 sub prepay existing ${existingD365Order.SalesOrderNumber}`,
            maxAttempts: 3,
          }
        );
        const depositCheck = await dynamics.verifyDepositFulfillmentApplied(
          existingD365Order.SalesOrderNumber,
          dataAreaId
        );
        console.log(
          `[Subscription] ✅ D365 prepayment ensured for existing order: ${prepayAmount} ${order.currency} ` +
            `(THK_DepositFulfillment=${depositCheck.depositFulfillment ?? "<empty>"}, ` +
            `expectedInvoiceType=${depositCheck.ok ? "Prepayment" : "Standard"})`
        );
        return {
          status: "created",
          amount: prepayAmount,
          depositFulfillment: depositCheck.depositFulfillment,
          expectedInvoiceType: depositCheck.ok ? "Prepayment" : "Standard",
        };
      });
      return {
        status: "already_exists",
        d365OrderNumber: existingD365Order.SalesOrderNumber,
        subscriptionContractId,
      };
    }

    const d365Header = await step.run("create-d365-order-header", async () => {
      if (!config.features.enableDynamicsSync) {
        return { status: "skipped", salesOrderNumber: "" };
      }

      const headerPayload = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId, {
        shortAddress: saudiShortAddress,
      });

      const result = await retryWithBackoff(
        () => dynamics.createSalesOrderHeaderV3(headerPayload),
        { label: `D365 sub header ${shopifyOrderName}` }
      );
      console.log(
        `[Subscription] ✅ D365 header created: ${result.SalesOrderNumber} for ${shopifyOrderName}`
      );
      return { status: "created", salesOrderNumber: result.SalesOrderNumber };
    });

    if (!d365Header.salesOrderNumber) {
      return { status: "skipped", reason: "D365 sync disabled" };
    }

    const d365OrderNumber = d365Header.salesOrderNumber;

    // =========================================================================
    // STEP 6: Create D365 Order Lines
    // =========================================================================
    try {
      await step.run("create-d365-order-lines", async () => {
        if (!config.features.enableDynamicsSync) {
          return {
            status: "skipped" as const,
            orderLinesSupabase: {
              attempted: false as const,
              skipReason: "dynamics_sync_disabled" as const,
              note: "ENABLE_DYNAMICS_SYNC off — no order_lines write",
            },
          };
        }

        const lineItems = toD365SalesOrderLines(
          order,
          d365OrderNumber,
          warehouseName,
          true,
          dataAreaId
        );

        const lineResults = await Promise.all(
          lineItems.map((line) =>
            (async () => {
              try {
                const created = await retryWithBackoff(() => dynamics.createSalesOrderLine(line), {
                  label: `D365 sub line ${line.itemNumber}`,
                  shouldRetry: (err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    return !isNonRetryableOrderError(msg);
                  },
                });
                const lot = created?.InventoryLotId ? String(created.InventoryLotId).trim() : "";
                return {
                  skipped: false as const,
                  itemNumber: line.itemNumber,
                  inventoryLotId: lot,
                };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (isServiceSkuItemNumber(line.itemNumber) && isD365ItemNotFoundError(msg)) {
                  console.warn(
                    `[D365][Subscription] Skipping missing service SKU line ${line.itemNumber} for ${d365OrderNumber}: ${msg}`
                  );
                  return { skipped: true as const, itemNumber: line.itemNumber, error: msg };
                }
                throw err;
              }
            })()
          )
        );

        const d365InventoryLotsBySku: Record<string, string> = {};
        for (const r of lineResults) {
          if (r.skipped) continue;
          const sku = String(r.itemNumber || "")
            .trim()
            .toUpperCase();
          const lot = "inventoryLotId" in r ? String(r.inventoryLotId || "").trim() : "";
          if (sku && lot) d365InventoryLotsBySku[sku] = lot;
        }

        const skippedItemNumbers = new Set(
          lineResults.filter((r) => r.skipped).map((r) => r.itemNumber.toUpperCase())
        );

        const lineRecords: OrderLineRecord[] = toOrderLineRecords(
          order,
          d365OrderNumber,
          warehouseName,
          dataAreaId
        )
          .filter((r) => !skippedItemNumbers.has(r.d365ItemNumber.toUpperCase()))
          .map((r) => ({
            shopify_order_id: String(shopifyOrderId),
            shopify_order_name: shopifyOrderName || order.name,
            shopify_line_item_id: r.shopifyLineItemId,
            shopify_sku: r.shopifySku,
            d365_item_number: r.d365ItemNumber,
            d365_sales_order_number: d365OrderNumber,
            data_area_id: dataAreaId,
            quantity: r.quantity,
            price: r.price,
            dynamics_inventory_lot_id:
              d365InventoryLotsBySku[r.d365ItemNumber.toUpperCase()] ?? null,
            is_service_line: r.isServiceLine,
          }));

        const saveResult: SaveOrderLinesResult = await saveOrderLines(lineRecords);

        const orderLinesSupabase = {
          attempted: true as const,
          d365LineCount: lineItems.length,
          recordsPrepared: lineRecords.length,
          skippedD365ServiceLines: skippedItemNumbers.size,
          save: saveResult,
          preview: lineRecords.slice(0, 12).map((r) => ({
            shopify_line_item_id: r.shopify_line_item_id,
            d365_item_number: r.d365_item_number,
            hasLotId: !!r.dynamics_inventory_lot_id,
          })),
        };

        console.log(
          `[Subscription] ✅ Created ${lineItems.length} D365 lines for ${shopifyOrderName}; order_lines upsert:`,
          JSON.stringify(saveResult)
        );

        return {
          status: "created" as const,
          lineCount: lineItems.length,
          orderLinesSupabase,
        };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isNonRetryableOrderError(errorMsg)) {
        throw new NonRetriableError(`[D365_NON_RETRYABLE] ${shopifyOrderName}: ${errorMsg}`);
      }
      throw error;
    }

    // =========================================================================
    // STEP 7: Confirm & Prepay D365 Order
    // =========================================================================
    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      await retryWithBackoff(() => dynamics.confirmSalesOrder(d365OrderNumber, dataAreaId), {
        label: `D365 sub confirm ${d365OrderNumber}`,
      });
      console.log(`[Subscription] ✅ D365 order confirmed: ${d365OrderNumber}`);
      return { status: "confirmed" };
    });

    await step.run("prepay-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      const prepayAmount = calculatePrepaymentAmount(order);
      if (prepayAmount <= 0) return { status: "skipped", reason: "zero amount" };
      await retryWithBackoff(() => dynamics.createPrepayment(d365OrderNumber, dataAreaId), {
        label: `D365 sub prepay ${d365OrderNumber}`,
      });
      const depositCheck = await dynamics.verifyDepositFulfillmentApplied(
        d365OrderNumber,
        dataAreaId
      );
      console.log(
        `[Subscription] ✅ D365 prepayment created: ${prepayAmount} ${order.currency} ` +
          `(THK_DepositFulfillment=${depositCheck.depositFulfillment ?? "<empty>"}, ` +
          `expectedInvoiceType=${depositCheck.ok ? "Prepayment" : "Standard"})`
      );
      return {
        status: "created",
        amount: prepayAmount,
        depositFulfillment: depositCheck.depositFulfillment,
        expectedInvoiceType: depositCheck.ok ? "Prepayment" : "Standard",
      };
    });

    // =========================================================================
    // STEP 8: Create GPS Outbound Order
    // =========================================================================
    const gpsResult = await step.run("create-gps-order", async () => {
      if (!config.features.enableGpsSync)
        return { status: "skipped" as const, reason: "GPS sync disabled", gpsOrderId: undefined };
      if (!shouldSendToGps(order, warehouseName))
        return { status: "skipped" as const, reason: "Not a GPS warehouse", gpsOrderId: undefined };

      try {
        const gpsOrder = toGpsOutboundOrder(
          order,
          d365OrderNumber,
          warehouseName,
          saudiShortAddress
        );
        const result = await gps.createOutboundOrder(
          gpsOrder,
          warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
        );
        const gpsOrderId = result?.response?.data?.[0]?.orderNo;
        console.log(`[Subscription] ✅ GPS order created: ${gpsOrderId} for ${shopifyOrderName}`);

        // Store metafield immediately (same step, saves a round-trip)
        if (gpsOrderId) {
          await setGpsOrderMetafield(shopifyOrderId, {
            gpsOrderId,
            warehouse: warehouseName,
            d365OrderNumber,
            createdAt: new Date().toISOString(),
          });
        }

        return { status: "created" as const, gpsOrderId, reason: undefined };
      } catch (err: any) {
        if (err instanceof OutOfStockError || err?.message?.includes("库存不足")) {
          console.warn(
            `[Subscription] ⚠️  OOS for ${shopifyOrderName}: ${err.message}. Parking in backorder queue.`
          );
          return {
            status: "backorder" as const,
            reason: err.message as string,
            gpsOrderId: undefined,
          };
        }
        throw err;
      }
    });

    // =========================================================================
    // STEP 9: Park OOS orders into the backorder queue
    // =========================================================================
    if (gpsResult.status === "backorder") {
      await step.sendEvent("park-backorder", {
        id: `backorder-created-sub-${shopifyOrderId}`,
        name: "backorder/created" as const,
        data: {
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber,
          warehouse: warehouseName,
          errorMessage: gpsResult.reason || "OOS",
          errorType: "out_of_stock" as const,
          failedSkus:
            order.line_items
              ?.filter((i: any) => i.requires_shipping && !i.gift_card)
              .map((i: any) => i.sku)
              .filter(Boolean) || [],
          // Park OOS in backorders, but avoid automatic retry loops.
          maxRetries: 0,
          retryCount: 0,
          createdAt: new Date().toISOString(),
        },
      });
    }

    // =========================================================================
    // STEP 10: Notify CS Platform
    // =========================================================================
    const openAiAdsConversion = config.openAiAds.enabled
      ? await step.run("enqueue-openai-ads-conversion", async () => {
          const conversion = await enqueueOpenAiAdsConversion({
            shopifyOrderId,
            shopifyOrderName,
            occurredAt: order.processed_at || order.created_at,
          });
          await inngest.send({
            id: `openai-ads-${conversion.eventId}`,
            name: "openai.ads/conversion.queued",
            data: { eventId: conversion.eventId },
          });
          return conversion;
        })
      : null;

    await step.run("notify-cs-platform", async () => {
      try {
        const finalStatus = gpsResult.status === "backorder" ? "backorder" : "completed";
        await csPlatform.sendOrderUpdate(
          {
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber,
            status: finalStatus,
            warehouse: warehouseName,
            subscriptionContractId,
            state:
              saudiShortAddress || openAiAdsConversion
                ? {
                    ...(saudiShortAddress ? { saudiShortAddress } : {}),
                    ...(openAiAdsConversion ? { openAiAdsConversion } : {}),
                  }
                : undefined,
          },
          {
            inngestIdempotencyKey,
            inngestRunId: _runId || undefined,
          }
        );
      } catch (err) {
        console.warn(`[Subscription] CS Platform notify failed:`, err);
      }
      return { status: "notified" };
    });

    const finalStatus = gpsResult.status === "backorder" ? "backorder" : "completed";
    console.log(
      `[Subscription] ✅ Done: ${shopifyOrderName} → D365: ${d365OrderNumber} | GPS: ${gpsResult.gpsOrderId || gpsResult.status} | Status: ${finalStatus}`
    );
    console.log(`[Subscription] ========================================`);

    await step.run("subscription-processing-summary", async () => {
      const totalProcessingMs = Date.now() - flowStartedAt;
      logFlowEvent({
        flow: "subscription_renewal",
        step: "processing_summary",
        status: finalStatus === "completed" ? "completed" : finalStatus,
        runId: _runId || undefined,
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber,
        durationMs: totalProcessingMs,
        payload: {
          totalProcessingMs,
          gpsOrderId: gpsResult.gpsOrderId,
          warehouse: warehouseName,
        },
      });
      await flushFlowLogs();
    });

    return {
      status: finalStatus,
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber,
      gpsOrderId: gpsResult.gpsOrderId,
      warehouse: warehouseName,
      subscriptionContractId,
    };
  }
);
