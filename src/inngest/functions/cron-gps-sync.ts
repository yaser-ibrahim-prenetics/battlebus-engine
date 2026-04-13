// ============================================================================
// GPS FULFILLMENT SYNC (Scheduled Polling)
// ============================================================================
// Polls GPS warehouse API for fulfilled orders and creates Shopify fulfillments
// Serverless-friendly: splits processing into small batches
//
// Flow:
// 1. Get GPS order IDs from Supabase (fast) — falls back to Shopify metafields
// 2. Query GPS API in batches for all orders
// 3. Filter for status 3 (fulfilled) within configured hours
// 4. For each fulfilled order, create Shopify fulfillment and trigger D365 sync

import { inngest } from "../client";
import { config, GPS_STATUS } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import * as shopify from "@/lib/clients/shopify";
import * as slack from "@/lib/clients/slack";
import { THROTTLE_CONFIGS } from "@/lib/utils/constants";
import type { ShopifyFulfillment } from "../events";
import { gpsSimulationStore } from "@/lib/stores/gps-simulation";
import { getLocationIdForWarehouse } from "@/lib/services/location-routing";
import { createClient } from "@supabase/supabase-js";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

// Process orders in small batches to avoid serverless timeouts
const BATCH_SIZE = 10;

export const syncGpsFulfillments = inngest.createFunction(
  {
    id: "cron-gps-sync",
    name: "Sync GPS Fulfillments",
    concurrency: { limit: 1 },
    throttle: THROTTLE_CONFIGS.CRON,
    triggers: [{ cron: `*/${config.gps.scheduleIntervalMinutes} * * * *` }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;

    await logFlowEvent({
      flow: "gps_sync",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { batchSize: BATCH_SIZE },
    });

    if (!config.features.enableGpsSync) {
      await logFlowEvent({
        flow: "gps_sync",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { skipped: true, reason: "gps_sync_disabled" },
      });
      return { status: "skipped", reason: "GPS sync disabled" };
    }

    // STEP 1: Get GPS order IDs from Shopify metafields, query GPS in batches, filter for status 3
    // Returns fulfilled orders AND all order statuses for visibility
    const gpsResult = await step.run("get-gps-order-ids", async () => {
      return getAllFulfilledGpsOrders();
    });

    const { fulfilledOrders, allOrderStatuses } = gpsResult;

    // If no fulfilled orders, return with all statuses for visibility
    if (fulfilledOrders.length === 0) {
      await logFlowEvent({
        flow: "gps_sync",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { totalOrdersChecked: allOrderStatuses.length, fulfilledCount: 0 },
      });
      return {
        status: "success",
        message: "No fulfilled GPS orders found in configured time window",
        totalOrdersChecked: allOrderStatuses.length,
        allOrderStatuses, // Show all orders and their GPS statuses
      };
    }

    console.log(`[GPS Sync] Found ${fulfilledOrders.length} fulfilled GPS orders to process`);

    // STEP 2: Process fulfilled orders in batches with API rate limiting
    const processedBatches = [];

    for (let i = 0; i < fulfilledOrders.length; i += BATCH_SIZE) {
      const chunk = fulfilledOrders.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

      const batchResult = await step.run(`process-fulfilled-batch-${batchNumber}`, async () => {
        return processFulfilledOrdersBatch(chunk);
      });
      processedBatches.push(batchResult);

      // Add delay between batches to respect API rate limits
      if (i + BATCH_SIZE < fulfilledOrders.length) {
        await step.sleep("rate-limit-delay", "500ms");
      }
    }

    const totalFulfilled = processedBatches.reduce((sum, b) => sum + b.fulfilled.length, 0);
    const totalErrors = processedBatches.reduce((sum, b) => sum + b.errors.length, 0);
    const allFulfilledOrderIds = processedBatches.flatMap((b) => b.fulfilled);

    // Log summary
    const hoursBack = config.gps.fulfillmentHoursBack;
    if (totalFulfilled > 0) {
      console.log(
        `[GPS Sync] Summary: Found ${totalFulfilled} GPS orders fulfilled in last ${hoursBack} hours`
      );
      console.log(
        `[GPS Sync] All fulfilled order IDs (platformOrderNo): ${allFulfilledOrderIds.join(", ")}`
      );
    } else {
      console.log(`[GPS Sync] Summary: No GPS orders fulfilled in last ${hoursBack} hours`);
    }

    if (totalFulfilled > 0 || totalErrors > 0) {
      await slack.sendInfoMessage(
        "gps",
        `GPS Sync: ${totalFulfilled} fulfilled, ${totalErrors} errors out of ${fulfilledOrders.length} GPS orders processed.`
      );
    }

    await logFlowEvent({
      flow: "gps_sync",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        totalOrdersChecked: allOrderStatuses.length,
        fulfilledCount: totalFulfilled,
        errors: totalErrors,
      },
    });

    return {
      status: "completed",
      totalOrdersChecked: allOrderStatuses.length,
      fulfilledCount: totalFulfilled,
      fulfilledOrderIds: allFulfilledOrderIds,
      errors: totalErrors,
      allOrderStatuses, // Show all orders and their GPS statuses
      batches: processedBatches,
    };
  }
);

// Type for fulfilled GPS order with all shipment details
type FulfilledGpsOrder = {
  platformOrderNo: string; // Shopify order name
  shopifyOrderId: string; // Shopify order ID (for fulfillment)
  outboundOrderNo: string; // GPS order ID
  logisticsTrackNo: string; // Tracking number
  logisticsCarrier: string; // Carrier name
  outboundTime: string; // Fulfillment timestamp
  warehouse: GpsWarehouseName;
};

// Type for GPS order status summary (for logging all orders)
type GpsOrderStatusSummary = {
  shopifyOrderName: string;
  shopifyOrderId: string;
  gpsOrderId: string;
  gpsStatus: number;
  gpsStatusText: string;
  warehouse: string;
  trackingNumber?: string;
  carrier?: string;
  outboundTime?: string;
};

// GPS status codes
const GPS_STATUS_TEXT: Record<number, string> = {
  0: "Created",
  1: "Processing",
  2: "Ready to Ship",
  3: "Fulfilled/Shipped",
  4: "Delivered",
  5: "Exception",
};

// Result type including all order statuses for visibility
type GpsSyncResult = {
  fulfilledOrders: FulfilledGpsOrder[];
  allOrderStatuses: GpsOrderStatusSummary[];
};

// Get GPS order data from Supabase (instead of Shopify metafields), query GPS API, filter for status 3
async function getAllFulfilledGpsOrders(): Promise<GpsSyncResult> {
  const gpsOrderData: Array<{
    gpsOrderId: string;
    warehouse: string;
    shopifyOrderName: string;
    shopifyOrderId: string;
  }> = [];

  // Try Supabase first — much faster than N+1 Shopify metafield calls
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

  const daysBack = config.gps.fulfillmentPollDaysBack;
  const pollCutoff = new Date();
  pollCutoff.setUTCDate(pollCutoff.getUTCDate() - daysBack);
  const pollCutoffIso = pollCutoff.toISOString();
  console.log(
    `[GPS Sync] Fulfillment poll window: last ${daysBack} day(s), created_at >= ${pollCutoffIso}`
  );

  if (supabase) {
    // Single query: recent unfulfilled GPS orders with gps_order_no (created within poll window)
    const { data: rows, error } = await supabase
      .from("orders")
      .select("id, shopify_order_id, shopify_order_name, gps_order_no, warehouse")
      .not("gps_order_no", "is", null)
      .in("warehouse", ["GPS Warehouse", "GPS UK Warehouse"])
      .or("shopify_fulfillment_status.is.null,shopify_fulfillment_status.neq.fulfilled")
      .gte("created_at", pollCutoffIso)
      .limit(500);

    if (error) {
      console.warn(`[GPS Sync] Supabase query failed, falling back to Shopify metafields: ${error.message}`);
    } else if (rows && rows.length > 0) {
      for (const row of rows) {
        if (row.gps_order_no && row.warehouse) {
          gpsOrderData.push({
            gpsOrderId: row.gps_order_no,
            warehouse: row.warehouse,
            shopifyOrderName: row.shopify_order_name || row.id,
            shopifyOrderId: row.shopify_order_id || row.id,
          });
        }
      }
      console.log(`[GPS Sync] Found ${gpsOrderData.length} GPS orders from Supabase (no Shopify calls needed)`);
    }
  }

  // Fallback to Shopify metafields if Supabase returned nothing
  if (gpsOrderData.length === 0) {
    console.log(`[GPS Sync] Falling back to Shopify metafield lookup...`);
    const orders = await shopify.getUnfulfilledOrders(250, daysBack);
    console.log(`[GPS Sync] Checking ${orders.length} orders for GPS metafields...`);

    for (const order of orders) {
      try {
        const gpsData = await shopify.getGpsOrderMetafield(order.id);
        if (gpsData) {
          gpsOrderData.push({
            gpsOrderId: gpsData.gpsOrderId,
            warehouse: gpsData.warehouse,
            shopifyOrderName: order.name,
            shopifyOrderId: order.id.toString(),
          });
        }
      } catch (error) {
        console.warn(`[GPS Sync] Failed to get GPS metafield for order ${order.id}: ${error}`);
      }
    }
  }

  console.log(`[GPS Sync] Found ${gpsOrderData.length} GPS order IDs to query`);
  if (gpsOrderData.length > 0) {
    const orderNames = gpsOrderData.map((d) => d.shopifyOrderName).join(", ");
    console.log(`[GPS Sync] Shopify orders with GPS: ${orderNames}`);
  }

  if (gpsOrderData.length === 0) {
    return { fulfilledOrders: [], allOrderStatuses: [] };
  }

  // Step 2: Create mapping from GPS order ID to Shopify order data
  const gpsOrderIdToShopifyData = new Map<
    string,
    {
      shopifyOrderName: string;
      shopifyOrderId: string;
      warehouse: GpsWarehouseName;
    }
  >();

  for (const item of gpsOrderData) {
    const warehouse = item.warehouse as GpsWarehouseName;
    if (warehouse === "GPS Warehouse" || warehouse === "GPS UK Warehouse") {
      gpsOrderIdToShopifyData.set(item.gpsOrderId, {
        shopifyOrderName: item.shopifyOrderName,
        shopifyOrderId: item.shopifyOrderId,
        warehouse,
      });
    }
  }

  // Group by warehouse for batch queries
  const warehouseGroups: Record<GpsWarehouseName, string[]> = {
    "GPS Warehouse": [],
    "GPS UK Warehouse": [],
  };

  for (const item of gpsOrderData) {
    const warehouse = item.warehouse as GpsWarehouseName;
    if (warehouse === "GPS Warehouse" || warehouse === "GPS UK Warehouse") {
      warehouseGroups[warehouse].push(item.gpsOrderId);
    }
  }

  // Step 3: Query GPS in batches for each warehouse and filter for status 3 within configured hours
  const allFulfilledOrders: FulfilledGpsOrder[] = [];
  const allOrderStatuses: GpsOrderStatusSummary[] = [];
  const hoursBack = config.gps.fulfillmentHoursBack;
  const timeWindowAgo = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  for (const warehouse of ["GPS Warehouse", "GPS UK Warehouse"] as GpsWarehouseName[]) {
    const gpsOrderIds = warehouseGroups[warehouse];
    if (gpsOrderIds.length === 0) continue;

    console.log(
      `[GPS Sync] [${warehouse}] Querying GPS for ${gpsOrderIds.length} orders in batches`
    );

    // Query GPS in batches
    for (let i = 0; i < gpsOrderIds.length; i += BATCH_SIZE) {
      const batch = gpsOrderIds.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(gpsOrderIds.length / BATCH_SIZE);

      try {
        console.log(
          `[GPS Sync] [${warehouse}] Querying batch ${batchNumber}/${totalBatches} with ${batch.length} orders`
        );

        const { response } = await gps.getOutboundOrdersDetails(batch, warehouse);

        if (!response.data || response.code !== 200) {
          console.error(
            `[GPS Sync] [${warehouse}] Batch ${batchNumber} API error: ${response.msg}`
          );
          continue;
        }

        // Apply simulation: override GPS response with simulated fulfillment data
        // We use our mapping since GPS response might have empty platformOrderNo
        let gpsData = response.data;
        if (config.features.enableGpsFulfillmentSimulation) {
          gpsData = response.data.map((gpsOrder) => {
            // Get Shopify order name from our mapping
            const shopifyData = gpsOrderIdToShopifyData.get(gpsOrder.outboundOrderNo);
            if (shopifyData) {
              const simulated = gpsSimulationStore.getFulfillment(shopifyData.shopifyOrderName);
              if (simulated) {
                return {
                  ...gpsOrder,
                  status: GPS_STATUS.FULFILLED,
                  platformOrderNo: simulated.platformOrderNo,
                  logisticsTrackNo: simulated.trackingNumber,
                  logisticsCarrier: simulated.carrier,
                  outboundTime: simulated.outboundTime,
                };
              }
            }
            return gpsOrder;
          });
        }

        // Collect ALL order statuses for visibility
        for (const gpsOrder of gpsData) {
          const shopifyData = gpsOrderIdToShopifyData.get(gpsOrder.outboundOrderNo);
          allOrderStatuses.push({
            shopifyOrderName:
              shopifyData?.shopifyOrderName || gpsOrder.platformOrderNo || "Unknown",
            shopifyOrderId: shopifyData?.shopifyOrderId || "",
            gpsOrderId: gpsOrder.outboundOrderNo,
            gpsStatus: gpsOrder.status,
            gpsStatusText: GPS_STATUS_TEXT[gpsOrder.status] || `Unknown (${gpsOrder.status})`,
            warehouse,
            trackingNumber: gpsOrder.logisticsTrackNo || undefined,
            carrier: gpsOrder.logisticsCarrier || undefined,
            outboundTime: gpsOrder.outboundTime || undefined,
          });
        }

        // Filter for fulfilled orders (status 3) within configured time window
        const fulfilledOrders = gpsData.filter((gpsOrder) => {
          if (gpsOrder.status !== GPS_STATUS.FULFILLED) return false;

          // Get platformOrderNo from our mapping if GPS didn't return it
          const shopifyData = gpsOrderIdToShopifyData.get(gpsOrder.outboundOrderNo);
          const platformOrderNo = gpsOrder.platformOrderNo || shopifyData?.shopifyOrderName;

          if (!platformOrderNo) return false;
          if (!gpsOrder.outboundTime) return false;

          const outboundDate = new Date(gpsOrder.outboundTime);
          const isWithinTimeWindow = outboundDate >= timeWindowAgo;

          return isWithinTimeWindow;
        });

        if (fulfilledOrders.length > 0) {
          console.log(
            `[GPS Sync] [${warehouse}] Batch ${batchNumber}: Found ${fulfilledOrders.length} fulfilled orders in last ${hoursBack} hours`
          );

          // Collect fulfilled orders with all shipment details
          for (const gpsOrder of fulfilledOrders) {
            // Get Shopify order data from mapping (use GPS order ID or platformOrderNo)
            const shopifyData =
              gpsOrderIdToShopifyData.get(gpsOrder.outboundOrderNo) ||
              Array.from(gpsOrderIdToShopifyData.values()).find(
                (d) => d.shopifyOrderName === gpsOrder.platformOrderNo
              );

            if (!shopifyData) {
              console.warn(
                `[GPS Sync] No Shopify data found for GPS order ${gpsOrder.outboundOrderNo} (${gpsOrder.platformOrderNo})`
              );
              continue;
            }

            allFulfilledOrders.push({
              platformOrderNo: gpsOrder.platformOrderNo || shopifyData.shopifyOrderName,
              shopifyOrderId: shopifyData.shopifyOrderId,
              outboundOrderNo: gpsOrder.outboundOrderNo,
              logisticsTrackNo: gpsOrder.logisticsTrackNo,
              logisticsCarrier: gpsOrder.logisticsCarrier,
              outboundTime: gpsOrder.outboundTime,
              warehouse,
            });
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[GPS Sync] [${warehouse}] Batch ${batchNumber} failed: ${msg}`);
      }
    }
  }

  console.log(`[GPS Sync] Total orders checked: ${allOrderStatuses.length}`);
  console.log(`[GPS Sync] Total fulfilled orders: ${allFulfilledOrders.length}`);

  return {
    fulfilledOrders: allFulfilledOrders,
    allOrderStatuses,
  };
}

// Process a batch of fulfilled GPS orders - create Shopify fulfillment and trigger D365 sync
async function processFulfilledOrdersBatch(
  fulfilledOrders: FulfilledGpsOrder[]
): Promise<{ fulfilled: string[]; errors: string[]; skippedCount: number }> {
  const fulfilled: string[] = [];
  const errors: string[] = [];

  for (const fulfilledOrder of fulfilledOrders) {
    const {
      platformOrderNo,
      shopifyOrderId,
      outboundOrderNo,
      logisticsTrackNo,
      logisticsCarrier,
      outboundTime,
      warehouse,
    } = fulfilledOrder;

    try {
      // Use the Shopify order ID we already have (no need to search again)
      if (!shopifyOrderId) {
        errors.push(`GPS order ${outboundOrderNo} (${platformOrderNo}): Missing Shopify order ID`);
        continue;
      }

      // Get fulfillment orders from Shopify using the order ID
      const fulfillmentOrders = await shopify.getFulfillmentOrders(parseInt(shopifyOrderId));
      const openFulfillment = fulfillmentOrders.find(
        (fo) => fo.status === "open" || fo.status === "in_progress"
      );

      if (!openFulfillment) {
        console.log(
          `[GPS Sync] No open fulfillment found for ${platformOrderNo} (ID: ${shopifyOrderId}), skipping`
        );
        continue;
      }

      // Create Shopify fulfillment with tracking info
      const trackingUrl = getTrackingUrl(logisticsCarrier, logisticsTrackNo);

      const lineItems = openFulfillment.line_items.map((item) => ({
        id: item.id,
        quantity: item.fulfillable_quantity,
      }));

      const fulfillment = await shopify.createFulfillment(
        openFulfillment.id,
        {
          number: logisticsTrackNo,
          company: mapGpsCarrierToShopify(logisticsCarrier),
          url: trackingUrl,
        },
        lineItems
      );

      // Get the full Shopify order to build fulfillment event
      const shopifyOrder = await shopify.getOrder(parseInt(shopifyOrderId));

      // Map fulfillment order line items to Shopify order line items for fulfillment event
      const fulfillmentLineItems = openFulfillment.line_items.map((fulfillmentOrderItem) => {
        // Find matching line item in Shopify order by line_item_id
        const orderLineItem = shopifyOrder.line_items.find(
          (li) => li.id === fulfillmentOrderItem.line_item_id
        );

        return {
          id: fulfillmentOrderItem.line_item_id,
          variant_id: orderLineItem?.variant_id || fulfillmentOrderItem.variant_id || 0,
          title: orderLineItem?.title || "",
          quantity: fulfillmentOrderItem.fulfillable_quantity,
          sku: orderLineItem?.sku || "",
          name: orderLineItem?.name || "",
          price: orderLineItem?.price || "0",
          fulfillment_status: "fulfilled",
        };
      });

      const resolvedLocationId = await getLocationIdForWarehouse(warehouse);
      const locationIdNum = resolvedLocationId
        ? parseInt(resolvedLocationId)
        : warehouse === "GPS UK Warehouse"
          ? parseInt(config.shopify.im8.locations.gpsUk || "0")
          : parseInt(config.shopify.im8.locations.gps || "0");

      // Trigger process-shopify-fulfillment function to sync to D365
      await inngest.send({
        name: "shopify/order.fulfilled",
        data: {
          shopifyOrderId: shopifyOrderId,
          shopifyOrderName: platformOrderNo,
          shopifyStore: config.shopify.im8.shopDomain,
          orderJson: shopifyOrder as any,
          fromGpsSync: true,
          fulfillments: [
            {
              id: fulfillment.id,
              order_id: parseInt(shopifyOrderId),
              status: "success",
              created_at: outboundTime || new Date().toISOString(),
              updated_at: new Date().toISOString(),
              tracking_company: mapGpsCarrierToShopify(logisticsCarrier),
              tracking_number: logisticsTrackNo,
              tracking_numbers: [logisticsTrackNo],
              tracking_url: trackingUrl,
              tracking_urls: [trackingUrl],
              location_id: locationIdNum,
              line_items: fulfillmentLineItems,
            } as ShopifyFulfillment,
          ],
          receivedAt: new Date().toISOString(),
        },
      });

      fulfilled.push(platformOrderNo);
      console.log(
        `[GPS Sync] Successfully processed fulfillment for ${platformOrderNo} (Shopify ID: ${shopifyOrderId})`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`GPS order ${outboundOrderNo} (${platformOrderNo}): ${msg}`);
    }
  }

  return { fulfilled, errors, skippedCount: 0 };
}

function getTrackingUrl(carrier: string, trackingNumber: string): string {
  const carrierLower = (carrier || "").toLowerCase();
  if (carrierLower.includes("fedex"))
    return `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
  if (carrierLower.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (carrierLower.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (carrierLower.includes("dhl"))
    return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  if (carrierLower.includes("sf"))
    return `https://www.sf-express.com/en/dynamic_function/waybill/#search/bill-number/${trackingNumber}`;
  return `https://track.aftership.com/${trackingNumber}`;
}

function mapGpsCarrierToShopify(gpsCarrier: string): string {
  const carrierMap: Record<string, string> = {
    "FEDEX-IP": "FedEx",
    "FEDEX-GROUND": "FedEx",
    FEDEX: "FedEx",
    "UPS-GROUND": "UPS",
    UPS: "UPS",
    USPS: "USPS",
    "DHL-EXPRESS": "DHL Express",
    DHL: "DHL Express",
    "SF-EXPRESS": "SF Express",
    SF: "SF Express",
  };
  return carrierMap[(gpsCarrier || "").toUpperCase()] || gpsCarrier;
}
