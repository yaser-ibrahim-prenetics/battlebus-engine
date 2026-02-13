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
import type { ShopifyOrderPayload, ShopifyFulfillment, ShopifyFulfillmentLineItem } from "../events";
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
        ? getDataAreaIdFromLocation(nonGpsFulfillment.locationId || "")
        : config.dynamics.dataAreaId;

      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
      return dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
    });

    if (!d365Order) {
      await slack.sendWarningMessage(
        "dynamics",
        `Shopify Fulfillment: D365 order not found for ${shopifyOrderName} (${shopifyOrderId})`
      );
      return {
        status: "no_d365_order",
        shopifyOrderId,
        shopifyOrderName,
        message: "D365 order not found - may not have been created yet",
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

    return {
      status: "success",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: d365Order.SalesOrderNumber,
      fulfillmentCount: fulfillments.length,
      fulfillmentResults,
      processedAt: new Date().toISOString(),
    };
  }
);
