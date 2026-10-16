// ============================================================================
// SHOPIFY FULFILLMENT → D365 SYNC
// ============================================================================
// Handles orders/fulfilled webhook from Shopify
// STORD, HK warehouse, and GPS locations: manual fulfillments in Shopify post packing slip to D365.
// cron-gps-sync also emits this event with fromGpsSync for the automated GPS ship path.

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import * as shopifyClient from "@/lib/clients/shopify";
import type { ShopifyOrderPayload, ShopifyFulfillment } from "../events";
import {
  isGpsFulfillment,
  isStordFulfillment,
  getDataAreaIdFromLocation,
  getWarehouseNameFromLocation,
} from "@/lib/utils/validation";
import { getWarehouseConfigForDataAreaId } from "@/lib/helpers/warehouse";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { storePendingAction } from "@/lib/services/pending-actions";
import { resolveD365OrderHeaderForLifecycle } from "@/lib/services/d365-order-header-resolution";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { processOrderFulfillments } from "./process-shopify-fulfillment/process-order-fulfillments";
import { syncPayPalTracking } from "./process-shopify-fulfillment/paypal-tracking";
import { isThkFulfilmentIncompleteError } from "@/lib/helpers/d365-thk-fulfilment";

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
            const firstFulfillment =
              Array.isArray(fulfillments) && fulfillments.length > 0
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
      const fulfillmentResults = await processOrderFulfillments({
        step,
        fulfillments,
        order,
        d365Order,
        shopifyOrderId,
        shopifyOrderName,
        runId: _runId,
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
        const firstErrorMessage = String(
          firstErrorResult?.error || "Fulfillment persistence failed"
        );
        const firstErrorIsInventory = isFulfillmentInventoryIssueError(firstErrorMessage);
        const firstErrorIsFulfilmentIncomplete = isThkFulfilmentIncompleteError(firstErrorMessage);
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

      const paypalResult = await syncPayPalTracking({
        step,
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentResults,
      });

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
      const errorType = isInventoryIssue ? "inventory_insufficient" : "d365_fulfillment_error";

      const failedShipFromWarehouse = (() => {
        const firstFulfillment =
          Array.isArray(fulfillments) && fulfillments.length > 0
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
      throw error instanceof Error ? error : new Error(`[Fulfillment] Uncaught: ${errorMsg}`);
    }
  }
);
