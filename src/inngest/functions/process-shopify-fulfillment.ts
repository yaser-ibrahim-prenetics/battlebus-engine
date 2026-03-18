// ============================================================================
// SHOPIFY FULFILLMENT → D365 SYNC
// ============================================================================
// Handles orders/fulfilled webhook from Shopify
// Used for STORD (Shopify plugin) and HK Warehouse fulfillments
// GPS fulfillments are handled by cron-gps-sync.ts (polling)

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import * as paypal from "@/lib/clients/paypal";
import * as shopifyClient from "@/lib/clients/shopify";
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
  filterDummySkus,
} from "@/lib/utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { storePendingAction } from "@/lib/services/pending-actions";

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
  },
  { event: "shopify/order.fulfilled" },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, orderJson, fulfillments } = event.data;
    const order = orderJson as ShopifyOrderPayload;

    // Identify fulfillment source for routing
    const fulfillmentSources = fulfillments.map((f: ShopifyFulfillment) => ({
      id: f.id,
      locationId: f.location_id,
      isGps: isGpsFulfillment(f.location_id || ""),
      isStord: isStordFulfillment(f.location_id || ""),
    }));

    // Skip GPS fulfillments from webhooks - they are handled by cron-gps-sync
    // But allow GPS fulfillments when explicitly triggered by cron-gps-sync (for D365 sync)
    const gpsOnly = fulfillmentSources.every((s: { isGps: boolean }) => s.isGps);
    const isFromGpsSync = (event.data as any).fromGpsSync === true;

    if (gpsOnly && !isFromGpsSync) {
      return {
        status: "skipped_gps",
        shopifyOrderId,
        shopifyOrderName,
        reason: "GPS fulfillments from webhook - handled by cron-gps-sync",
      };
    }

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentCount: fulfillments.length,
        sources: fulfillmentSources,
      };
    }

    // Get D365 order
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }

      // Determine data area from first non-GPS fulfillment location
      const nonGpsFulfillment = fulfillmentSources.find((s: { isGps: boolean }) => !s.isGps);
      const dataAreaId = nonGpsFulfillment
        ? getDataAreaIdFromLocation(nonGpsFulfillment.locationId || "") ?? config.dynamics.dataAreaId
        : config.dynamics.dataAreaId;

      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
      return dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
    });

    if (!d365Order) {
      if ((event.data as any).fromDrain) {
        await slack.sendWarningMessage(
          "dynamics",
          `[PendingActions] D365 order still not found for ${shopifyOrderName} after drain — fulfillment cannot be synced`
        );
        return {
          status: "failed",
          shopifyOrderId,
          shopifyOrderName,
          message: "D365 order not found after drain — fulfillment permanently skipped",
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

      for (const fulfillment of fulfillments) {
        // Skip GPS fulfillments
        if (isGpsFulfillment(fulfillment.location_id || "")) {
          results.push({
            fulfillmentId: fulfillment.id,
            status: "skipped_gps",
            reason: "Handled by GPS sync cron",
          });
          continue;
        }

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

          if (filteredItems.length === 0) {
            results.push({
              fulfillmentId: fulfillment.id,
              status: "skipped_no_items",
            });
            continue;
          }

          // Get lotId mapping from D365 sales order lines
          const lotIdMap = await dynamics.getLotIdMap(d365Order.SalesOrderNumber!, dataAreaId);

          const fulfillmentLines = filteredItems.map((item) => ({
            itemNumber: item.sku,
            quantity: item.quantity,
            trackingNumber: fulfillment.tracking_number || "",
            shippingSiteId: "Prenetics",
            shippingWarehouseId: "",
            shippingWarehouseLocationId: "",
            lotId: lotIdMap[item.sku] || "",
          }));

          // Create D365 packing slip
          await dynamics.createFulfilment({
            dataAreaId,
            salesOrderNumber: d365Order.SalesOrderNumber!,
            type: "PackingSlip",
            confirmedShippedDate: fulfillment.created_at
              ? new Date(fulfillment.created_at).toISOString().split("T")[0]
              : new Date().toISOString().split("T")[0],
            lines: fulfillmentLines,
          });

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

          results.push({
            fulfillmentId: fulfillment.id,
            status: "error",
            error: errorMsg,
          });
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

    // Send fulfillment events to CS platform with Shopify status
    for (const fulfillmentResult of fulfillmentResults) {
      if (fulfillmentResult.status === "success" && fulfillmentResult.trackingNumber) {
        await csPlatform.sendOrderFulfilled({
          orderId: shopifyOrderId,
          shopifyOrderName,
          trackingNumber: fulfillmentResult.trackingNumber,
          carrier: fulfillmentResult.carrier || "",
          fulfillmentId: fulfillmentResult.fulfillmentId,
          shopifyFulfillmentStatus: order.fulfillment_status || "fulfilled",
          shopifyFinancialStatus: order.financial_status,
        });
      }
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
          await slack.sendWarningMessage(
            "system",
            `PayPal tracking sync failed for ${shopifyOrderName}: ${errorMsg}`
          ).catch((error) => {
            console.warn('[Fulfillment] Non-critical operation failed:', error instanceof Error ? error.message : error);
          });

          return { status: "error", error: errorMsg };
        }
      });
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
  }
);
