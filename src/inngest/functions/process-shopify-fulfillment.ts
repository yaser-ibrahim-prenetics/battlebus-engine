// ============================================================================
// SHOPIFY FULFILLMENT → D365 SYNC
// ============================================================================
// Handles orders/fulfilled webhook from Shopify
// STORD, HK warehouse, and GPS locations: manual fulfillments in Shopify post packing slip to D365.
// cron-gps-sync also emits this event with fromGpsSync for the automated GPS ship path.

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import * as paypal from "@/lib/clients/paypal";
import * as shopifyClient from "@/lib/clients/shopify";
import { mapShopifySkuToDynamicsForOrderLine } from "@/lib/transformers/sku";
import type {
  ShopifyOrderPayload,
  ShopifyFulfillment,
  ShopifyFulfillmentLineItem,
} from "../events";
import {
  isDummyFulfillment,
  isGpsFulfillment,
  isStordFulfillment,
  getDataAreaIdFromLocation,
  getWarehouseNameFromLocation,
  filterDummySkus,
} from "@/lib/utils/validation";
import { getFulfilmentConfig, getWarehouseConfigForDataAreaId } from "@/lib/helpers/warehouse";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  BACKORDER_CONFIGS,
  retryWithBackoff,
} from "@/lib/utils/constants";
import { storePendingAction } from "@/lib/services/pending-actions";
import { resolveD365OrderHeaderForLifecycle } from "@/lib/services/d365-order-header-resolution";
import { fetchD365InventoryLotsByShopifyOrder } from "@/lib/services/supabase-order-lookup";
import {
  fetchOrderLines,
  buildLotIdMapFromOrderLines,
  getLotFromSavedOrderLineByShopifyLineItemId,
  filterUnfulfilledServiceLines,
  markServiceLinesFulfilled,
} from "@/lib/services/supabase-order-lines";
import { logFlowEvent, logFlowEventSync } from "@/lib/services/supabase-flow-logs";
import {
  getThkFulfilmentWarningMessage,
  isThkFulfilmentIncompleteError,
} from "@/lib/helpers/d365-thk-fulfilment";

function normalizeSkuForLotLookup(rawSku: unknown): string {
  const sku = String(rawSku || "").trim();
  if (!sku) return "";
  return mapShopifySkuToDynamicsForOrderLine(sku).trim().toUpperCase();
}

function isFulfillmentInventoryIssueError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("cannot be reserved") ||
    m.includes("only 0.00 are available") ||
    m.includes("inventory insufficient") ||
    m.includes("out of stock") ||
    m.includes("库存不足") ||
    m.includes("unmaintained new product")
  );
}

/** Retries inside `createFulfilment` — never for terminal inventory / business-rule failures. */
function isTransientFulfillmentApiError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  if (isFulfillmentInventoryIssueError(m)) return false;
  if (isThkFulfilmentIncompleteError(m)) return false;
  if (m.includes("rate limit") || m.includes("429")) return true;
  if (m.includes("503") || m.includes("502") || m.includes("504")) return true;
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("econnreset")) return true;
  if (m.includes("network") || m.includes("socket hang up")) return true;
  return false;
}

export const processShopifyFulfillment = inngest.createFunction(
  {
    id: "process-shopify-fulfillment",
    name: "Process Shopify Fulfillment → D365",
    idempotency: "event.data.shopifyOrderId + '-' + event.id",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.FULFILLMENT,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
    triggers: [{ event: "shopify/order.fulfilled" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, fulfillments } = event.data;
    const order = orderJson as ShopifyOrderPayload;
    const _flowStart = Date.now();
    // Inngest function run id (ULID) for /runs/{id} — NOT event.id (that is the *event* id, e.g. idempotency key).
    const _runId = String(runId ?? "");

    logFlowEvent({
      flow: "fulfillment",
      step: "start",
      status: "started",
      runId: _runId || undefined,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      payload: { fulfillmentCount: fulfillments?.length },
    });

    try {

    // Identify fulfillment source for routing
    const fulfillmentSources = fulfillments.map((f: ShopifyFulfillment) => ({
      id: f.id,
      locationId: f.location_id,
      isGps: isGpsFulfillment(f.location_id || ""),
      isStord: isStordFulfillment(f.location_id || ""),
    }));

    const isFromGpsSync = (event.data as any).fromGpsSync === true;

    const isDynamicsInitiatedShopifyMirror = fulfillments.some((f: ShopifyFulfillment) => {
      const note = String((f as unknown as { note?: string }).note || "");
      return note.includes("FulfillmentType: dynamics_initiated");
    });
    if (isDynamicsInitiatedShopifyMirror) {
      logFlowEvent({
        flow: "fulfillment",
        step: "skip_d365",
        status: "completed",
        runId: _runId || undefined,
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName,
        payload: { reason: "dynamics_initiated_fulfillment" },
        durationMs: Date.now() - _flowStart,
      });
      return {
        status: "skipped",
        shopifyOrderId,
        shopifyOrderName,
        reason: "Shopify fulfillment mirrors D365 shipment; packing slip not sent again",
      };
    }

    const isReconDbShopifyMirror = fulfillments.some((f: ShopifyFulfillment) => {
      const note = String((f as unknown as { note?: string }).note || "");
      return note.includes("FulfillmentType: recon_db_shopify_align");
    });
    if (isReconDbShopifyMirror) {
      await step.run("notify-hub-recon-db-shopify-mirror", async () => {
        const f =
          Array.isArray(fulfillments) && fulfillments.length > 0
            ? (fulfillments[0] as ShopifyFulfillment)
            : undefined;
        const tracking = String(f?.tracking_number || "RECON-ALIGN");
        const carrier = String(f?.tracking_company || "Other");
        let financial: string | undefined;
        let shopifyFulfillmentStatus = "fulfilled";
        try {
          const fresh = await shopifyClient.getOrder(Number(shopifyOrderId));
          financial = fresh?.financial_status;
          shopifyFulfillmentStatus = fresh?.fulfillment_status || "fulfilled";
        } catch {
          /* Hub update still worthwhile without fresh financials */
        }
        await csPlatform.sendOrderFulfilled({
          orderId: shopifyOrderId,
          shopifyOrderName: shopifyOrderName || order?.name || String(shopifyOrderId),
          trackingNumber: tracking,
          carrier,
          fulfillmentId: f?.id ? String(f.id) : undefined,
          shopifyFulfillmentStatus,
          shopifyFinancialStatus: financial,
          fulfillmentSource: "shopify",
          d365FulfillmentStatus: "synced",
        });
      });
      logFlowEvent({
        flow: "fulfillment",
        step: "skip_d365",
        status: "completed",
        runId: _runId || undefined,
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName,
        payload: { reason: "recon_db_shopify_align" },
        durationMs: Date.now() - _flowStart,
      });
      return {
        status: "skipped",
        shopifyOrderId,
        shopifyOrderName,
        reason:
          "Reconciliation mirror: Shopify updated to match DB; D365 packing slip not sent again",
      };
    }

    if (config.features.dryRunMode) {
      return await step.run("dry-run", async () => ({
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentCount: fulfillments.length,
        sources: fulfillmentSources,
      }));
    }

    // Get D365 order (Supabase d365_order_number by Shopify name first — same as refund)
    const d365Order = await step.run("get-d365-order", async () => {
      const fulfillmentForDataArea =
        fulfillmentSources.find((s: { isGps: boolean }) => !s.isGps) ?? fulfillmentSources[0];
      const preferredDataAreaId =
        getDataAreaIdFromLocation(fulfillmentForDataArea?.locationId || "") ??
        config.dynamics.dataAreaId;

      const orderPayload = order as ShopifyOrderPayload;
      return resolveD365OrderHeaderForLifecycle({
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName: shopifyOrderName || orderPayload?.name,
        shippingCountryCode: orderPayload?.shipping_address?.country_code,
        preferredDataAreaId,
      });
    });

    if (!d365Order) {
      if ((event.data as any).fromDrain) {
        await slack.sendWarningMessage(
          "dynamics",
          `[PendingActions] D365 order still not found for ${shopifyOrderName} after drain — fulfillment cannot be synced`
        );

        const errorMsg = `D365 order not found after drain — fulfillment permanently skipped`;
        const failedShipFromWarehouse = (() => {
          const firstFulfillment = Array.isArray(fulfillments) && fulfillments.length > 0
            ? (fulfillments[0] as ShopifyFulfillment)
            : undefined;
          return firstFulfillment
            ? getWarehouseNameFromLocation(firstFulfillment.location_id || "") || undefined
            : undefined;
        })();

        await step.run("emit-backorder-fulfillment-no-d365-after-drain", async () => {
          await inngest.send({
            name: "backorder/created",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: "",
              warehouse: failedShipFromWarehouse || "Unknown",
              errorMessage: errorMsg,
              errorType: "d365_fulfillment_error",
              failedSkus: [],
              retryCount: 0,
              maxRetries: 0,
              orderJson: order,
              createdAt: new Date().toISOString(),
              source: "shopify/order.fulfilled",
              sourceEventName: "shopify/order.fulfilled",
              failureStage: "fulfillment",
              failureSystem: "d365",
              retryMode: "fulfillment_replay",
              backorderQueue: "fulfilment",
              shipFromWarehouseName: failedShipFromWarehouse,
            },
          });
        });

        await step.run("notify-hub-fulfillment-no-d365-after-drain", async () => {
          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              orderJson: order,
              status: "backorder",
              processingStatus: "backorder",
              d365FulfillmentStatus: "failed",
              error: errorMsg,
              lastError: errorMsg,
              errorType: "d365_fulfillment_error",
              lastErrorType: "d365_fulfillment_error",
              state: {
                failureContext: {
                  stage: "fulfillment",
                  system: "d365",
                  sourceEventName: "shopify/order.fulfilled",
                  retryMode: "fulfillment_replay",
                  backorderQueue: "fulfilment",
                  shipFromWarehouseName: failedShipFromWarehouse,
                },
              },
            },
            { inngestRunId: _runId || undefined }
          );
        });

        return {
          status: "failed",
          shopifyOrderId,
          shopifyOrderName,
          message: errorMsg,
        };
      }
      await step.run("store-pending-fulfill", async () => {
        await storePendingAction(shopifyOrderId, {
          action: "fulfill",
          eventName: "shopify/order.fulfilled",
          eventData: event.data,
          createdAt: new Date().toISOString(),
        });
      });
      console.log(
        `[PendingActions] Deferred fulfillment for ${shopifyOrderName} — D365 order not yet created`
      );
      return {
        status: "deferred",
        shopifyOrderId,
        shopifyOrderName,
        reason: "D365 order not yet created, action queued for replay",
      };
    }

    // spock-store: PostPrepayment runs only at order create (orders/paid), never at fulfillment.

    // Process each fulfillment
    const fulfillmentResults = await step.run("process-fulfillments", async () => {
      if (!config.features.enableDynamicsSync) {
        return fulfillments.map((f: ShopifyFulfillment) => ({
          fulfillmentId: f.id,
          status: "skipped_dynamics_disabled",
        }));
      }

      const results = [];
      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;
      let backorderQueued = false;

      // Build a stable map from Shopify order line_item.id -> normalized SKU used in D365.
      // This protects fulfillment when webhook/item SKU labels drift after order creation.
      let orderLineSkuById: Record<string, string> = {};
      const orderPayload = order as ShopifyOrderPayload | null;
      if (Array.isArray(orderPayload?.line_items) && orderPayload.line_items.length > 0) {
        for (const li of orderPayload.line_items as Array<any>) {
          const lineItemId = Number(li?.id);
          if (!Number.isFinite(lineItemId) || lineItemId <= 0) continue;
          const normalizedSku = normalizeSkuForLotLookup(li?.sku);
          if (!normalizedSku) continue;
          orderLineSkuById[String(Math.trunc(lineItemId))] = normalizedSku;
        }
      } else {
        try {
          const freshOrder = await shopifyClient.getOrder(String(shopifyOrderId));
          if (Array.isArray((freshOrder as any)?.line_items)) {
            for (const li of (freshOrder as any).line_items as Array<any>) {
              const lineItemId = Number(li?.id);
              if (!Number.isFinite(lineItemId) || lineItemId <= 0) continue;
              const normalizedSku = normalizeSkuForLotLookup(li?.sku);
              if (!normalizedSku) continue;
              orderLineSkuById[String(Math.trunc(lineItemId))] = normalizedSku;
            }
          }
        } catch (error) {
          console.warn(
            `[D365][LotIdDebug] Could not fetch order line-item SKU map for fallback on ${shopifyOrderName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      const supabaseLotMap = await fetchD365InventoryLotsByShopifyOrder(
        String(shopifyOrderId),
        shopifyOrderName || order?.name
      );

      // All persisted D365 lines (product + service) from Supabase — Shopify webhooks
      // never include synthetic shipping/tax lines; we merge those here for Dynamics.
      const savedOrderLines = await fetchOrderLines(
        String(shopifyOrderId),
        shopifyOrderName || order?.name
      );
      const orderLinesLotMap = buildLotIdMapFromOrderLines(savedOrderLines);
      const unfulfilledServiceLines = filterUnfulfilledServiceLines(savedOrderLines);
      let serviceLinesFulfilled = false;

      if (savedOrderLines.length > 0) {
        console.log(
          `[D365][OrderLines] Loaded ${savedOrderLines.length} saved line(s) from Supabase for ${shopifyOrderName}; ` +
            `${unfulfilledServiceLines.length} unfulfilled service line(s)`
        );
      }

      for (const fulfillment of fulfillments) {
        let fulfillmentSkuCandidates: string[] = [];
        // Skip dummy/adjustment fulfillments
        if (isDummyFulfillment(fulfillment)) {
          results.push({
            fulfillmentId: fulfillment.id,
            status: "skipped_dummy",
          });
          continue;
        }

        try {
          // Filter out dummy SKUs and map to D365 format
          const filteredItems = filterDummySkus<ShopifyFulfillmentLineItem>(fulfillment.line_items);
          fulfillmentSkuCandidates = filteredItems
            .map((item) => String(item.sku || "").trim())
            .filter(Boolean);

          if (filteredItems.length === 0) {
            results.push({
              fulfillmentId: fulfillment.id,
              status: "skipped_no_items",
            });
            continue;
          }

          // OData first; Hub orders.state snapshot + order_lines table fill gaps (incl. service lots).
          let lotIdMap = dynamics.mergeLotIdMaps(
            await dynamics.getLotIdMap(d365Order.SalesOrderNumber!, dataAreaId),
            supabaseLotMap,
            orderLinesLotMap
          );

          const shipFromWarehouseName =
            getWarehouseNameFromLocation(fulfillment.location_id || "") ||
            getWarehouseConfigForDataAreaId(dataAreaId).name;
          let fulfilmentWarehouseConfig = {
            shippingSiteId: "Prenetics",
            shippingWarehouseId: "",
            shippingWarehouseLocationId: "",
          };
          try {
            fulfilmentWarehouseConfig = getFulfilmentConfig(shipFromWarehouseName);
          } catch {
            console.warn(
              `[D365] No fulfilment warehouse config for ${shipFromWarehouseName}; posting with site only`
            );
          }

          const buildFulfillmentLines = () =>
            filteredItems.map((item) => ({
              // Prefer fulfillment item SKU, but fall back to order line item SKU when needed.
              // `item.id` on fulfillment line items maps to Shopify order line_item.id.
              itemNumber: (() => {
                const rawFulfillmentSku = String(item.sku || "").trim();
                const normalizedFulfillmentSku = normalizeSkuForLotLookup(rawFulfillmentSku);
                const lineItemId = Number((item as any)?.id);
                const lineItemSkuFromOrder =
                  Number.isFinite(lineItemId) && lineItemId > 0
                    ? orderLineSkuById[String(Math.trunc(lineItemId))] || ""
                    : "";
                const normalizedOrderLineSku = normalizeSkuForLotLookup(lineItemSkuFromOrder);
                const chosenSku =
                  normalizedFulfillmentSku ||
                  normalizedOrderLineSku ||
                  String(rawFulfillmentSku || "").trim();
                return chosenSku;
              })(),
              // getLotIdMap keys are normalized to uppercase for resilient SKU matching.
              // createFulfilment will throw if any line still has no Lotid.
              quantity: item.quantity,
              trackingNumber: fulfillment.tracking_number || "",
              shippingSiteId: fulfilmentWarehouseConfig.shippingSiteId,
              shippingWarehouseId: fulfilmentWarehouseConfig.shippingWarehouseId,
              shippingWarehouseLocationId: fulfilmentWarehouseConfig.shippingWarehouseLocationId,
              lotId: (() => {
                const lineItemId = Number((item as any)?.id);
                const lineItemIdStr =
                  Number.isFinite(lineItemId) && lineItemId > 0
                    ? String(Math.trunc(lineItemId))
                    : "";
                const fromSaved = lineItemIdStr
                  ? getLotFromSavedOrderLineByShopifyLineItemId(savedOrderLines, lineItemIdStr)
                  : "";
                if (fromSaved) return fromSaved;
                const rawFulfillmentSku = String(item.sku || "").trim();
                const normalizedFulfillmentSku = normalizeSkuForLotLookup(rawFulfillmentSku);
                const normalizedOrderLineSku =
                  Number.isFinite(lineItemId) && lineItemId > 0
                    ? normalizeSkuForLotLookup(
                        orderLineSkuById[String(Math.trunc(lineItemId))] || ""
                      )
                    : "";
                return (
                  lotIdMap[normalizedFulfillmentSku] ||
                  lotIdMap[normalizedOrderLineSku] ||
                  lotIdMap[
                    String(rawFulfillmentSku || "")
                      .trim()
                      .toUpperCase()
                  ] ||
                  ""
                );
              })(),
            }));

          let fulfillmentLines = buildFulfillmentLines();
          let missingLotIdSkus = fulfillmentLines
            .filter((line) => !String(line.lotId || "").trim())
            .map((line) => line.itemNumber);
          if (missingLotIdSkus.length > 0) {
            console.warn(
              `[D365][LotIdDebug] Missing lot IDs before fulfilment call: ${JSON.stringify({
                shopifyOrderName,
                salesOrderNumber: d365Order.SalesOrderNumber,
                dataAreaId,
                fulfillmentId: fulfillment.id,
                fulfillmentSkus: filteredItems.map((item) => item.sku),
                lotMapKeys: Object.keys(lotIdMap),
                missingLotIdSkus,
              })}`
            );

            // Enforce "lot IDs come from Dynamics": re-fetch latest SalesOrderLines once before posting.
            const refreshedOdataLotMap = await dynamics.getLotIdMap(
              d365Order.SalesOrderNumber!,
              dataAreaId
            );
            lotIdMap = dynamics.mergeLotIdMaps(
              refreshedOdataLotMap,
              supabaseLotMap,
              orderLinesLotMap
            );
            fulfillmentLines = buildFulfillmentLines();
            missingLotIdSkus = fulfillmentLines
              .filter((line) => !String(line.lotId || "").trim())
              .map((line) => line.itemNumber);

            if (missingLotIdSkus.length > 0) {
              console.warn(
                `[D365][LotIdDebug] Missing lot IDs after Dynamics refetch: ${JSON.stringify({
                  shopifyOrderName,
                  salesOrderNumber: d365Order.SalesOrderNumber,
                  dataAreaId,
                  fulfillmentId: fulfillment.id,
                  lotMapKeys: Object.keys(lotIdMap),
                  missingLotIdSkus,
                })}`
              );
            }
          }

          // Append service lines (shipping + tax) from Supabase — not present on Shopify fulfillments.
          // First successful product fulfillment includes them once; then mark fulfilled (spock-store parity).
          const serviceLinesToAppend =
            !serviceLinesFulfilled && unfulfilledServiceLines.length > 0
              ? unfulfilledServiceLines
              : [];

          let serviceLotMap = lotIdMap;
          const serviceNeedsOdataLot = serviceLinesToAppend.some((sl) => {
            const rowLot = String(sl.dynamics_inventory_lot_id ?? "").trim();
            const key = String(sl.d365_item_number ?? "")
              .trim()
              .toUpperCase();
            return !rowLot && !String(serviceLotMap[key] ?? "").trim();
          });
          if (serviceNeedsOdataLot && serviceLinesToAppend.length > 0) {
            const refreshedForService = await dynamics.getLotIdMap(
              d365Order.SalesOrderNumber!,
              dataAreaId
            );
            serviceLotMap = dynamics.mergeLotIdMaps(
              refreshedForService,
              supabaseLotMap,
              orderLinesLotMap
            );
          }

          const fulfilmentLinesWithService = [
            ...fulfillmentLines,
            ...serviceLinesToAppend.map((sl) => {
              const itemUpper = String(sl.d365_item_number ?? "")
                .trim()
                .toUpperCase();
              const rowLot = String(sl.dynamics_inventory_lot_id ?? "").trim();
              const lotId = rowLot || String(serviceLotMap[itemUpper] ?? "").trim() || "";
              return {
                itemNumber: sl.d365_item_number,
                quantity: Number(sl.quantity) || 1,
                lotId,
                trackingNumber: "",
                shippingSiteId: fulfilmentWarehouseConfig.shippingSiteId,
                shippingWarehouseId: fulfilmentWarehouseConfig.shippingWarehouseId,
                shippingWarehouseLocationId: fulfilmentWarehouseConfig.shippingWarehouseLocationId,
              };
            }),
          ];

          if (serviceLinesToAppend.length > 0) {
            console.log(
              `[D365][ServiceLines] Appending ${serviceLinesToAppend.length} service line(s) to fulfillment for ${shopifyOrderName}: ${serviceLinesToAppend.map((l) => l.d365_item_number).join(", ")}`
            );
          }

          // Create D365 packing slip (retry only transient API failures, not inventory/OData business errors)
          const fulfilmentPost = await retryWithBackoff(
            () =>
              dynamics.createFulfilment({
                dataAreaId,
                salesOrderNumber: d365Order.SalesOrderNumber!,
                type: "shipment",
                confirmedShippedDate: fulfillment.created_at
                  ? new Date(fulfillment.created_at).toISOString().split("T")[0]
                  : new Date().toISOString().split("T")[0],
                lines: fulfilmentLinesWithService,
              }),
            {
              label: `d365-create-fulfilment-${shopifyOrderName}-${fulfillment.id}`,
              maxAttempts: 4,
              shouldRetry: (err) => isTransientFulfillmentApiError(err),
            }
          );

          const depositPrecheck = await dynamics.verifyDepositFulfillmentApplied(
            d365Order.SalesOrderNumber!,
            dataAreaId
          );
          const isDepositOrder = depositPrecheck.ok;
          const depositShipInvoiceCheck = isDepositOrder
            ? await dynamics.assertDepositShipmentInvoicingComplete(
                d365Order.SalesOrderNumber!,
                dataAreaId,
                fulfilmentPost.response,
                { depositFulfillment: true }
              )
            : { verified: false, processingStatus: depositPrecheck.processingStatus };

          const thkWarning = getThkFulfilmentWarningMessage(
            fulfilmentPost.response?.Message
          );
          if (thkWarning) {
            console.warn(
              `[D365] THK fulfilment warning for ${shopifyOrderName} (${d365Order.SalesOrderNumber}): ${thkWarning}`
            );
          }

          logFlowEvent({
            flow: "fulfillment",
            step: "d365_fulfilment_posted",
            level: thkWarning ? "warn" : "info",
            status: "completed",
            runId: _runId || undefined,
            shopifyOrderId: String(shopifyOrderId),
            shopifyOrderName,
            d365OrderNumber: d365Order.SalesOrderNumber,
            payload: {
              fulfillmentId: fulfillment.id,
              salesOrderNumber: d365Order.SalesOrderNumber,
              dataAreaId,
              fulfilmentType: "shipment",
              thkApiStatus: fulfilmentPost.response?.status,
              thkApiMessage: fulfilmentPost.response?.Message,
              thkApiWarning: thkWarning ?? undefined,
              thkApiResult: fulfilmentPost.response?.Result,
              depositStandardInvoiceVerified: depositShipInvoiceCheck.verified,
              salesOrderProcessingStatus: depositShipInvoiceCheck.processingStatus ?? undefined,
              fulfilmentWarehouse: shipFromWarehouseName,
              lineCount: fulfilmentLinesWithService.length,
              lines: fulfilmentLinesWithService.map((l) => ({
                itemNumber: l.itemNumber,
                quantity: l.quantity,
                lotId: l.lotId,
                site: l.shippingSiteId,
              })),
            },
          });

          // Mark service lines fulfilled so they are not sent again on subsequent fulfillments
          if (serviceLinesToAppend.length > 0) {
            serviceLinesFulfilled = true;
            await markServiceLinesFulfilled(
              String(shopifyOrderId),
              serviceLinesToAppend.map((l) => l.shopify_line_item_id)
            );
          }

          results.push({
            fulfillmentId: fulfillment.id,
            status: "success",
            source: isStordFulfillment(fulfillment.location_id || "") ? "STORD" : "Direct",
            trackingNumber: fulfillment.tracking_number,
            carrier: fulfillment.tracking_company,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          await slack.sendErrorMessage(
            isStordFulfillment(fulfillment.location_id || "") ? "stord" : "dynamics",
            `D365 Fulfillment failed for ${shopifyOrderName}: ${errorMsg}`
          );

          const invTerminal = isFulfillmentInventoryIssueError(errorMsg);
          const fulfilmentIncomplete = isThkFulfilmentIncompleteError(errorMsg);
          await logFlowEventSync({
            flow: "fulfillment",
            step: "d365-create-fulfilment",
            level: "error",
            status: "failed",
            runId: _runId || undefined,
            shopifyOrderId: String(shopifyOrderId),
            shopifyOrderName,
            d365OrderNumber: d365Order.SalesOrderNumber || undefined,
            errorMessage: errorMsg,
            errorType: fulfilmentIncomplete
              ? "d365_fulfilment_incomplete"
              : invTerminal
                ? "inventory_terminal"
                : "d365_fulfillment_error",
            payload: {
              fulfillmentId: fulfillment.id,
              terminalInventory: invTerminal,
            },
          });

          results.push({
            fulfillmentId: fulfillment.id,
            status: "error",
            error: errorMsg,
          });

          if (!backorderQueued && (invTerminal || fulfilmentIncomplete)) {
            backorderQueued = true;
            const failedSkus = fulfillmentSkuCandidates;
            // D365 inventory site (e.g. "GPS Warehouse" for U001) — used only
            // as failure context, NOT as the order's ship-from warehouse.
            const d365WarehouseName = (() => {
              try {
                return getWarehouseConfigForDataAreaId(dataAreaId).name;
              } catch {
                return `DataArea-${dataAreaId}`;
              }
            })();
            // Real ship-from warehouse derived from the failing fulfillment's
            // Shopify location — STORD ATL Location, GPS Warehouse, etc.
            // We pass this as the backorder `warehouse` so Hub does NOT
            // overwrite a STORD order's location with "GPS Warehouse".
            const shipFromWarehouseName =
              getWarehouseNameFromLocation(fulfillment.location_id || "") || undefined;

            await inngest.send({
              name: "backorder/created",
              data: {
                shopifyOrderId,
                shopifyOrderName,
                d365OrderNumber: d365Order.SalesOrderNumber,
                // Prefer real ship-from; fall back to D365 site only if unknown.
                warehouse: shipFromWarehouseName || d365WarehouseName,
                errorMessage: errorMsg,
                errorType: fulfilmentIncomplete
                  ? "d365_fulfilment_incomplete"
                  : "inventory_insufficient",
                failedSkus,
                retryCount: 0,
                maxRetries: BACKORDER_CONFIGS.maxRetries,
                orderJson: order,
                createdAt: new Date().toISOString(),
                source: "shopify/order.fulfilled",
                sourceEventName: "shopify/order.fulfilled",
                failureStage: "fulfillment",
                failureSystem: "d365",
                retryMode: "fulfillment_replay",
                backorderQueue: "fulfilment",
                d365WarehouseName,
                shipFromWarehouseName,
              },
            });
            console.warn(
              `[Backorder] Queued from fulfillment (${fulfilmentIncomplete ? "d365_fulfilment_incomplete" : "inventory"}) for ${shopifyOrderName}: ${errorMsg}; SKUs=${failedSkus.join(", ")}`
            );
          }
        }
      }

      return results;
    });

    // Send success notification for STORD orders
    const stordFulfillments = fulfillmentResults.filter(
      (r: { status: string; source?: string }) => r.status === "success" && r.source === "STORD"
    );
    if (stordFulfillments.length > 0) {
      await slack.sendInfoMessage(
        "stord",
        `STORD Fulfillment synced: ${shopifyOrderName} - ${stordFulfillments.length} fulfillment(s)`
      );
    }

    // Determine fulfillment source for downstream tracking.
    // IMPORTANT:
    // - Source should describe *which pipeline triggered this run* (method-1
    //   Shopify webhook vs method-2 GPS scheduler), not which warehouse handled
    //   one of potentially multiple fulfillment legs.
    // - Mixed/partial fulfillments can include STORD-location successes while
    //   still being Shopify-manual initiated; inferring `stord` here pollutes
    //   Hub journey classification.
    const isFromGpsSyncPath = isFromGpsSync;
    const fulfillmentSource: "gps" | "stord" | "shopify" = isFromGpsSyncPath ? "gps" : "shopify";

    // Send fulfillment events to CS platform with Shopify status and source
    for (let i = 0; i < fulfillmentResults.length; i++) {
      const fulfillmentResult = fulfillmentResults[i];
      if (fulfillmentResult.status === "success" && fulfillmentResult.trackingNumber) {
        await step.run(`notify-hub-fulfilled-${i}`, async () => {
          await csPlatform.sendOrderFulfilled({
            orderId: shopifyOrderId,
            shopifyOrderName,
            trackingNumber: fulfillmentResult.trackingNumber,
            carrier: fulfillmentResult.carrier || "",
            fulfillmentId: fulfillmentResult.fulfillmentId,
            shopifyFulfillmentStatus: order.fulfillment_status || "fulfilled",
            shopifyFinancialStatus: order.financial_status,
            fulfillmentSource,
            d365FulfillmentStatus: "synced",
            gpsFulfillmentStatus: fulfillmentSource === "gps" ? "synced" : undefined,
          });
        });
      }
    }

    const anyFulfillmentError = fulfillmentResults.some(
      (r: { status: string }) => r.status === "error"
    );
    const hasBackorderQueued = fulfillmentResults.some(
      (r: { status: string; error?: string }) =>
        r.status === "error" &&
        (isFulfillmentInventoryIssueError(String(r.error || "")) ||
          isThkFulfilmentIncompleteError(String(r.error || "")))
    );
    if (anyFulfillmentError) {
      const firstErrorResult = fulfillmentResults.find(
        (r: { status: string }) => r.status === "error"
      ) as { error?: string } | undefined;
      const firstErrorMessage = String(firstErrorResult?.error || "Fulfillment persistence failed");
      const firstErrorIsInventory = isFulfillmentInventoryIssueError(firstErrorMessage);
      const firstErrorIsFulfilmentIncomplete =
        isThkFulfilmentIncompleteError(firstErrorMessage);
      const queueErrorType = firstErrorIsFulfilmentIncomplete
        ? "d365_fulfilment_incomplete"
        : firstErrorIsInventory
          ? "inventory_insufficient"
          : "d365_fulfillment_error";
      const d365Site = (() => {
        try {
          return getWarehouseConfigForDataAreaId(
            d365Order.dataAreaId || config.dynamics.dataAreaId
          );
        } catch {
          return null;
        }
      })();
      const d365DataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;
      // First error row (D365 API, Stord, GPS, or inventory) — match by
      // fulfillment id so ship-from is correct for non-inventory failures too.
      const firstErr = fulfillmentResults.find(
        (r: { status: string }) => r.status === "error"
      ) as { fulfillmentId?: number; error?: string } | undefined;
      const firstFailedFulfillment = firstErr?.fulfillmentId
        ? fulfillments.find((f: ShopifyFulfillment) => f.id === firstErr.fulfillmentId)
        : undefined;
      const failedShipFromWarehouse = firstFailedFulfillment
        ? getWarehouseNameFromLocation(firstFailedFulfillment.location_id || "") || undefined
        : undefined;

      if (!hasBackorderQueued) {
        await step.run("emit-backorder-fulfillment-non-inventory", async () => {
          await inngest.send({
            name: "backorder/created",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: d365Order.SalesOrderNumber,
              warehouse: failedShipFromWarehouse || d365Site?.name || "Unknown",
              errorMessage: firstErrorMessage,
              errorType: queueErrorType,
              failedSkus: [],
              retryCount: 0,
              maxRetries: 0,
              orderJson: order,
              createdAt: new Date().toISOString(),
              source: "shopify/order.fulfilled",
              sourceEventName: "shopify/order.fulfilled",
              failureStage: "fulfillment",
              failureSystem: "d365",
              retryMode: "fulfillment_replay",
              backorderQueue: "fulfilment",
              d365WarehouseName: d365Site?.name,
              shipFromWarehouseName: failedShipFromWarehouse,
            },
          });
        });
      }

      await step.run("notify-hub-fulfillment-backorder", async () => {
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: d365Order.SalesOrderNumber,
            shopifyFulfillmentStatus: order.fulfillment_status || "fulfilled",
            shopifyFinancialStatus: order.financial_status,
            status: "backorder",
            processingStatus: "backorder",
            d365SyncStatus: "synced",
            d365FulfillmentStatus: "failed",
            error: firstErrorMessage,
            lastError: firstErrorMessage,
            errorType: queueErrorType,
            lastErrorType: queueErrorType,
            state: {
              failureContext: {
                stage: "fulfillment",
                system: "d365",
                sourceEventName: "shopify/order.fulfilled",
                retryMode: "fulfillment_replay",
                backorderQueue: "fulfilment",
                d365WarehouseName: d365Site?.name,
                d365DataAreaId,
                shipFromWarehouseName: failedShipFromWarehouse,
              },
            },
          },
          { inngestRunId: _runId || undefined }
        );
      });
    }

    // ========================================================================
    // PAYPAL TRACKING SYNC (non-blocking)
    // ========================================================================
    // If any transactions on this order used PayPal, push tracking to PayPal
    // for seller protection. Errors are logged but never fail the function.

    let paypalResult: unknown = null;

    if (paypal.isEnabled()) {
      paypalResult = await step.run("sync-paypal-tracking", async () => {
        try {
          // Get order transactions from Shopify to find PayPal ones
          const transactions = await shopifyClient.getOrderTransactions(shopifyOrderId);
          const paypalTransactions = transactions.filter(
            (t) =>
              t.gateway?.toLowerCase().includes("paypal") &&
              t.kind === "sale" &&
              t.status === "success"
          );

          if (paypalTransactions.length === 0) {
            return { status: "skipped", reason: "no PayPal transactions on this order" };
          }

          // Build tracker entries: each PayPal transaction × each fulfilled tracking number
          const successfulFulfillments = fulfillmentResults.filter(
            (r: { status: string; trackingNumber?: string }) =>
              r.status === "success" && r.trackingNumber
          );

          if (successfulFulfillments.length === 0) {
            return { status: "skipped", reason: "no successful fulfillments with tracking" };
          }

          const trackers: Array<{
            transactionId: string;
            trackingNumber: string;
            carrierName: string | null | undefined;
          }> = [];

          for (const txn of paypalTransactions) {
            for (const f of successfulFulfillments) {
              trackers.push({
                transactionId: String(txn.id),
                trackingNumber: f.trackingNumber!,
                carrierName: f.carrier,
              });
            }
          }

          const response = await paypal.syncTrackingBatch(trackers);

          return {
            status: "synced",
            trackersSubmitted: trackers.length,
            trackersProcessed: response.tracker_identifiers?.length || 0,
            errors: response.errors?.length || 0,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[PayPal] Tracking sync failed for ${shopifyOrderName}: ${errorMsg}`);

          // Non-blocking: log to Slack but don't throw
          await slack
            .sendWarningMessage(
              "system",
              `PayPal tracking sync failed for ${shopifyOrderName}: ${errorMsg}`
            )
            .catch((error) => {
              console.warn(
                "[Fulfillment] Non-critical operation failed:",
                error instanceof Error ? error.message : error
              );
            });

          return { status: "error", error: errorMsg };
        }
      });
    }

    logFlowEvent({
      flow: "fulfillment",
      step: "done",
      status: hasBackorderQueued || anyFulfillmentError ? "failed" : "completed",
      level: hasBackorderQueued || anyFulfillmentError ? "error" : "info",
      runId: _runId || undefined,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      durationMs: Date.now() - _flowStart,
      errorMessage:
        hasBackorderQueued || anyFulfillmentError
          ? (() => {
              const errRow = fulfillmentResults.find(
                (r: { status: string; error?: string }) => r.status === "error"
              ) as { error?: string } | undefined;
              return (
                errRow?.error ||
                (hasBackorderQueued
                  ? "Fulfillment failed: inventory insufficient (terminal)"
                  : "One or more fulfillments failed")
              );
            })()
          : undefined,
      payload: { fulfillmentCount: fulfillments.length, fulfillmentSource },
    });

    // ────────────────────────────────────────────────────────────────────────
    // Sequenced rerun hand-off: dispatch the next stage in
    // `event.data.runSequence` (set up by process-backorder when a manual
    // rerun chains order_creation → fulfillment_replay).
    // ────────────────────────────────────────────────────────────────────────
    if (!hasBackorderQueued && Array.isArray((event.data as any).runSequence)) {
      const incomingSequence = (event.data as any).runSequence as Array<
        import("../events").RunSequenceStage
      >;
      if (incomingSequence.length > 0) {
        try {
          const { advanceRunSequence } = await import("@/lib/services/run-sequence");
          await advanceRunSequence({
            shopifyOrderId,
            shopifyOrderName,
            completedStage: {
              id: `fulfillment_replay-${_runId || "unknown"}`,
              stage: "fulfillment_replay",
              eventName: "shopify/order.fulfilled",
              status: "completed",
              runId: _runId || undefined,
            },
            remaining: incomingSequence,
            orderJson: order,
            fulfillments,
            shopifyStore: (event.data as any).shopifyStore,
            inngestRunId: _runId || undefined,
          });
        } catch (err) {
          console.warn(
            `[RunSequence] Failed to advance after fulfillment_replay for ${shopifyOrderName}: ${err}`
          );
        }
      }
    }

    return {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      fulfillmentCount: fulfillments.length,
      fulfillmentResults,
      paypalResult,
      processedAt: new Date().toISOString(),
    };
    } catch (error) {
      // Top-level safety net: any uncaught error in the fulfillment pipeline
      // (D365 lookup throws, Supabase blip, transformer crash, etc.) must
      // still produce a fulfilment backorder + Hub status update so the
      // order is visible/retryable in Battle Hub. Without this, a Shopify
      // fulfillment that crashed mid-pipeline would silently disappear from
      // CS Platform.
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isInventoryIssue = isFulfillmentInventoryIssueError(errorMsg);
      const errorType = isInventoryIssue
        ? "inventory_insufficient"
        : "d365_fulfillment_error";

      const failedShipFromWarehouse = (() => {
        const firstFulfillment = Array.isArray(fulfillments) && fulfillments.length > 0
          ? (fulfillments[0] as ShopifyFulfillment)
          : undefined;
        return firstFulfillment
          ? getWarehouseNameFromLocation(firstFulfillment.location_id || "") || undefined
          : undefined;
      })();

      logFlowEvent({
        flow: "fulfillment",
        step: "uncaught-error",
        status: "failed",
        level: "error",
        runId: _runId || undefined,
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName,
        durationMs: Date.now() - _flowStart,
        errorType,
        errorMessage: errorMsg,
      });

      try {
        await step.run("emit-backorder-fulfillment-catch-all", async () => {
          await inngest.send({
            name: "backorder/created",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: "",
              warehouse: failedShipFromWarehouse || "Unknown",
              errorMessage: errorMsg,
              errorType,
              failedSkus: [],
              retryCount: 0,
              maxRetries: 0,
              orderJson: order,
              createdAt: new Date().toISOString(),
              source: "shopify/order.fulfilled",
              sourceEventName: "shopify/order.fulfilled",
              failureStage: "fulfillment",
              failureSystem: "d365",
              retryMode: "fulfillment_replay",
              backorderQueue: "fulfilment",
              shipFromWarehouseName: failedShipFromWarehouse,
            },
          });
        });

        await step.run("notify-hub-fulfillment-catch-all", async () => {
          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              orderJson: order,
              status: "backorder",
              processingStatus: "backorder",
              d365FulfillmentStatus: "failed",
              error: errorMsg,
              lastError: errorMsg,
              errorType,
              lastErrorType: errorType,
              state: {
                failureContext: {
                  stage: "fulfillment",
                  system: "d365",
                  sourceEventName: "shopify/order.fulfilled",
                  retryMode: "fulfillment_replay",
                  backorderQueue: "fulfilment",
                  shipFromWarehouseName: failedShipFromWarehouse,
                },
              },
            },
            { inngestRunId: _runId || undefined }
          );
        });

        await slack.sendErrorMessage(
          "dynamics",
          `[Fulfillment] Uncaught error for ${shopifyOrderName} — moved to fulfilment backorder queue: ${errorMsg}`
        );
      } catch (notifyErr) {
        // If notifying Hub itself crashes, we still need to surface the original
        // error so Inngest retries (and the next attempt may succeed).
        console.error(
          `[Fulfillment] Failed to notify Hub of catch-all error for ${shopifyOrderName}:`,
          notifyErr
        );
      }

      // Re-throw so Inngest marks the run as failed and retries (the
      // emit/notify step.run results are persisted, so they won't be re-run
      // unnecessarily; idempotent for transient failures).
      throw error instanceof Error
        ? error
        : new Error(`[Fulfillment] Uncaught: ${errorMsg}`);
    }
  }
);
