import { inngest } from "../../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import * as shopifyClient from "@/lib/clients/shopify";
import { mapShopifySkuToDynamicsForOrderLine } from "@/lib/transformers/sku";
import type {
  ShopifyOrderPayload,
  ShopifyFulfillment,
  ShopifyFulfillmentLineItem,
} from "../../events";
import {
  isDummyFulfillment,
  isStordFulfillment,
  getWarehouseNameFromLocation,
  filterDummySkus,
} from "@/lib/utils/validation";
import { getFulfilmentConfig, getWarehouseConfigForDataAreaId } from "@/lib/helpers/warehouse";
import { BACKORDER_CONFIGS, retryWithBackoff } from "@/lib/utils/constants";
import { fetchD365InventoryLotsByShopifyOrder } from "@/lib/services/order-lookup";
import {
  fetchOrderLines,
  buildLotIdMapFromOrderLines,
  getLotFromSavedOrderLineByShopifyLineItemId,
  filterUnfulfilledSupplementalLines,
  markServiceLinesFulfilled,
} from "@/lib/services/order-lines";
import { isSubscriptionRewardLineItemId } from "@/lib/helpers/subscription-rewards";
import { logFlowEvent, logFlowEventSync } from "@/lib/services/flow-logs";
import {
  getThkFulfilmentWarningMessage,
  isDepositFulfillmentOrder,
  isThkFulfilmentIncompleteError,
} from "@/lib/helpers/d365-thk-fulfilment";

function normalizeSkuForLotLookup(rawSku: unknown): string {
  const sku = String(rawSku || "").trim();
  return sku ? mapShopifySkuToDynamicsForOrderLine(sku).trim().toUpperCase() : "";
}

function isFulfillmentInventoryIssueError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("cannot be reserved") ||
    normalized.includes("only 0.00 are available") ||
    normalized.includes("inventory insufficient") ||
    normalized.includes("out of stock") ||
    normalized.includes("库存不足") ||
    normalized.includes("unmaintained new product")
  );
}

function isTransientFulfillmentApiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (isFulfillmentInventoryIssueError(message) || isThkFulfilmentIncompleteError(message))
    return false;
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("socket hang up")
  );
}

export async function processOrderFulfillments(params: {
  step: any;
  fulfillments: ShopifyFulfillment[];
  order: ShopifyOrderPayload;
  d365Order: any;
  shopifyOrderId: string | number;
  shopifyOrderName: string;
  runId: string;
}) {
  const { step, fulfillments, order, d365Order, shopifyOrderId, shopifyOrderName } = params;
  const _runId = params.runId;
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
    const orderLineSkuById: Record<string, string> = {};
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
    const unfulfilledSupplementalLines = filterUnfulfilledSupplementalLines(savedOrderLines);
    let supplementalLinesFulfilled = false;

    if (savedOrderLines.length > 0) {
      console.log(
        `[D365][OrderLines] Loaded ${savedOrderLines.length} saved line(s) from Supabase for ${shopifyOrderName}; ` +
          `${unfulfilledSupplementalLines.length} unfulfilled supplemental line(s)`
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
        const d365LineDimensionsMap = await dynamics.getSalesOrderLineFulfilmentDimensionsMap(
          d365Order.SalesOrderNumber!,
          dataAreaId
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
            ...(() => {
              const rawFulfillmentSku = String(item.sku || "").trim();
              const normalizedFulfillmentSku = normalizeSkuForLotLookup(rawFulfillmentSku);
              const lineItemId = Number((item as any)?.id);
              const normalizedOrderLineSku =
                Number.isFinite(lineItemId) && lineItemId > 0
                  ? normalizeSkuForLotLookup(orderLineSkuById[String(Math.trunc(lineItemId))] || "")
                  : "";
              const d365Dims =
                d365LineDimensionsMap[normalizedFulfillmentSku] ||
                d365LineDimensionsMap[normalizedOrderLineSku];
              return {
                shippingSiteId:
                  d365Dims?.shippingSiteId || fulfilmentWarehouseConfig.shippingSiteId,
                shippingWarehouseId:
                  d365Dims?.shippingWarehouseId || fulfilmentWarehouseConfig.shippingWarehouseId,
                shippingWarehouseLocationId:
                  d365Dims?.shippingWarehouseLocationId ||
                  fulfilmentWarehouseConfig.shippingWarehouseLocationId,
              };
            })(),
            lotId: (() => {
              const lineItemId = Number((item as any)?.id);
              const lineItemIdStr =
                Number.isFinite(lineItemId) && lineItemId > 0 ? String(Math.trunc(lineItemId)) : "";
              const fromSaved = lineItemIdStr
                ? getLotFromSavedOrderLineByShopifyLineItemId(savedOrderLines, lineItemIdStr)
                : "";
              if (fromSaved) return fromSaved;
              const rawFulfillmentSku = String(item.sku || "").trim();
              const normalizedFulfillmentSku = normalizeSkuForLotLookup(rawFulfillmentSku);
              const normalizedOrderLineSku =
                Number.isFinite(lineItemId) && lineItemId > 0
                  ? normalizeSkuForLotLookup(orderLineSkuById[String(Math.trunc(lineItemId))] || "")
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
        const supplementalLinesToAppend =
          !supplementalLinesFulfilled && unfulfilledSupplementalLines.length > 0
            ? unfulfilledSupplementalLines
            : [];

        let serviceLotMap = lotIdMap;
        const serviceNeedsOdataLot = supplementalLinesToAppend.some((sl) => {
          const rowLot = String(sl.dynamics_inventory_lot_id ?? "").trim();
          const key = String(sl.d365_item_number ?? "")
            .trim()
            .toUpperCase();
          return !rowLot && !String(serviceLotMap[key] ?? "").trim();
        });
        if (serviceNeedsOdataLot && supplementalLinesToAppend.length > 0) {
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
          ...supplementalLinesToAppend.map((sl) => {
            const itemUpper = String(sl.d365_item_number ?? "")
              .trim()
              .toUpperCase();
            const rowLot = String(sl.dynamics_inventory_lot_id ?? "").trim();
            const lotId = rowLot || String(serviceLotMap[itemUpper] ?? "").trim() || "";
            return {
              itemNumber: sl.d365_item_number,
              quantity: Number(sl.quantity) || 1,
              lotId,
              trackingNumber: isSubscriptionRewardLineItemId(sl.shopify_line_item_id)
                ? fulfillment.tracking_number || ""
                : "",
              shippingSiteId: fulfilmentWarehouseConfig.shippingSiteId,
              shippingWarehouseId: fulfilmentWarehouseConfig.shippingWarehouseId,
              shippingWarehouseLocationId: fulfilmentWarehouseConfig.shippingWarehouseLocationId,
            };
          }),
        ];

        if (supplementalLinesToAppend.length > 0) {
          console.log(
            `[D365][SupplementalLines] Appending ${supplementalLinesToAppend.length} supplemental line(s) to fulfillment for ${shopifyOrderName}: ${supplementalLinesToAppend.map((l) => l.d365_item_number).join(", ")}`
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
        const isDepositOrder = isDepositFulfillmentOrder({
          depositFulfillment: depositPrecheck.depositFulfillment,
          processingStatus: depositPrecheck.processingStatus,
        });
        const depositShipInvoiceCheck = isDepositOrder
          ? await dynamics.assertDepositShipmentInvoicingComplete(
              d365Order.SalesOrderNumber!,
              dataAreaId,
              fulfilmentPost.response,
              { depositFulfillment: true }
            )
          : { verified: false, processingStatus: depositPrecheck.processingStatus };

        const thkWarning = getThkFulfilmentWarningMessage(fulfilmentPost.response?.Message);
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
        if (supplementalLinesToAppend.length > 0) {
          supplementalLinesFulfilled = true;
          await markServiceLinesFulfilled(
            String(shopifyOrderId),
            supplementalLinesToAppend.map((l) => l.shopify_line_item_id)
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
  return fulfillmentResults;
}
