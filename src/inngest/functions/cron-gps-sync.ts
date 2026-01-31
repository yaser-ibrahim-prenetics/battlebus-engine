// ============================================================================
// GPS FULFILLMENT SYNC (Scheduled Polling)
// ============================================================================
// Polls GPS warehouse API for fulfilled orders and syncs to Shopify + D365
// Serverless-friendly: splits processing into small batches
//
// GPS Order Tracking Strategy:
// - When orders are sent to GPS (in process-shopify-order), we store the GPS order ID
//   in a Shopify metafield (namespace: battle_bus, key: gps_order)
// - This cron job fetches unfulfilled orders with GPS metafields and queries GPS
//   using the actual GPS order ID (not Shopify order name)
// - Filters for orders fulfilled in the configured time window (based on outboundTime, default 6 hours)
// - Uses platformOrderNo from GPS response to match Shopify orders
// - This is more reliable than spock-store's database approach since we're stateless

import { inngest } from "../client";
import { config, GPS_STATUS } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import * as shopify from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import { filterDummySkus } from "@/lib/utils/validation";
import { THROTTLE_CONFIGS } from "@/lib/utils/constants";
import type { GpsOrderMetafield } from "@/lib/clients/shopify";

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

// Process orders in small batches to avoid serverless timeouts
const BATCH_SIZE = 10;

export const syncGpsFulfillments = inngest.createFunction(
  {
    id: "cron-gps-sync",
    name: "Sync GPS Fulfillments",
    concurrency: { limit: 1 },
    throttle: THROTTLE_CONFIGS.CRON,
  },
  { cron: `*/${config.gps.scheduleIntervalMinutes} * * * *` },
  async ({ step }) => {
    if (!config.features.enableGpsSync) {
      return { status: "skipped", reason: "GPS sync disabled" };
    }

    // STEP 1: Get GPS order IDs from all orders with GPS metafields (not just unfulfilled)
    // We need GPS order IDs to query GPS API
    const gpsOrderData = await step.run("get-gps-order-ids", async () => {
      return getAllGpsOrderIds();
    });

    if (gpsOrderData.length === 0) {
      return { status: "success", message: "No GPS orders found" };
    }

    console.log(`[GPS Sync] Found ${gpsOrderData.length} GPS order IDs to check`);

    // STEP 2: Query GPS API for all orders (grouped by warehouse)
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

    const processedBatches = [];
    
    // STEP 3: Query GPS for each warehouse and process fulfilled orders
    for (const warehouse of ["GPS Warehouse", "GPS UK Warehouse"] as GpsWarehouseName[]) {
      const gpsOrderIds = warehouseGroups[warehouse];
      if (gpsOrderIds.length === 0) continue;

      // Split into batches for GPS API calls
      const gpsIdChunks = [];
      for (let i = 0; i < gpsOrderIds.length; i += BATCH_SIZE) {
        gpsIdChunks.push(gpsOrderIds.slice(i, i + BATCH_SIZE));
      }

      for (let i = 0; i < gpsIdChunks.length; i++) {
        const chunk = gpsIdChunks[i];
        const batchResult = await step.run(`query-gps-${warehouse}-batch-${i + 1}`, async () => {
          return queryGpsAndProcessFulfilled(chunk, warehouse);
        });
        processedBatches.push(batchResult);
      }
    }

    const totalFulfilled = processedBatches.reduce((sum, b) => sum + b.fulfilled.length, 0);
    const totalErrors = processedBatches.reduce((sum, b) => sum + b.errors.length, 0);
    const allFulfilledOrderIds = processedBatches.flatMap((b) => b.fulfilled);

    // Log summary
    if (totalFulfilled > 0) {
      console.log(
        `[GPS Sync] Summary: Found ${totalFulfilled} GPS orders fulfilled in last 6 hours`
      );
      console.log(
        `[GPS Sync] All fulfilled order IDs (platformOrderNo): ${allFulfilledOrderIds.join(", ")}`
      );
    } else {
      console.log(`[GPS Sync] Summary: No GPS orders fulfilled in last 6 hours`);
    }

    if (totalFulfilled > 0 || totalErrors > 0) {
      await slack.sendInfoMessage(
        "gps",
        `GPS Sync: ${totalFulfilled} fulfilled, ${totalErrors} errors out of ${gpsOrderData.length} GPS orders checked.`
      );
    }

    return {
      status: "completed",
      checked: gpsOrderData.length,
      fulfilled: totalFulfilled,
      fulfilledOrderIds: allFulfilledOrderIds,
      batches: processedBatches,
    };
  }
);

// Helper: Get all GPS order IDs from Shopify metafields
async function getAllGpsOrderIds(): Promise<Array<{ gpsOrderId: string; warehouse: string }>> {
  // Get all orders (not just unfulfilled) from last 30 days that might have GPS metafields
  const orders = await shopify.getUnfulfilledOrders(500, 30);
  
  console.log(`[GPS Sync] Checking ${orders.length} orders for GPS metafields...`);
  
  const gpsOrderIds: Array<{ gpsOrderId: string; warehouse: string }> = [];
  
  for (const order of orders) {
    try {
      const gpsData = await shopify.getGpsOrderMetafield(order.id);
      if (gpsData) {
        gpsOrderIds.push({
          gpsOrderId: gpsData.gpsOrderId,
          warehouse: gpsData.warehouse,
        });
      }
    } catch (error) {
      // Skip orders where we can't fetch metafields
      console.warn(`[GPS Sync] Failed to get GPS metafield for order ${order.id}: ${error}`);
    }
  }
  
  console.log(`[GPS Sync] Found ${gpsOrderIds.length} GPS order IDs`);
  return gpsOrderIds;
}

// Query GPS API and process fulfilled orders
async function queryGpsAndProcessFulfilled(
  gpsOrderIds: string[],
  warehouse: GpsWarehouseName
) {
  const fulfilled: string[] = [];
  const errors: string[] = [];

  console.log(`[GPS Sync] [${warehouse}] Querying GPS for ${gpsOrderIds.length} orders: ${gpsOrderIds.join(", ")}`);

  try {
    // Query GPS API directly
    const { response } = await gps.getOutboundOrdersDetails(gpsOrderIds, warehouse);

    if (!response.data || response.code !== 200) {
      errors.push(`${warehouse}: API error - ${response.msg}`);
      return { fulfilled, errors, skippedCount: 0 };
    }

    console.log(`[GPS Sync] [${warehouse}] GPS returned ${response.data.length} orders`);

    // Filter for fulfilled orders (status 3) in the last 6 hours
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const fulfilledGpsOrders = response.data.filter((gpsOrder) => {
      if (gpsOrder.status !== GPS_STATUS.FULFILLED) return false;
      
      // Check if outboundTime is within last 6 hours
      if (!gpsOrder.outboundTime) return false;
      
      const outboundDate = new Date(gpsOrder.outboundTime);
      const isWithinLast6Hours = outboundDate >= sixHoursAgo;
      
      return isWithinLast6Hours;
    });

    if (fulfilledGpsOrders.length > 0) {
      console.log(
        `[GPS Sync] [${warehouse}] Found ${fulfilledGpsOrders.length} fulfilled orders in last 6 hours`
      );
      const fulfilledOrderIds = fulfilledGpsOrders.map((order) => order.platformOrderNo);
      console.log(
        `[GPS Sync] [${warehouse}] Fulfilled order IDs (platformOrderNo): ${fulfilledOrderIds.join(", ")}`
      );
    }

    // Process each fulfilled GPS order using platformOrderNo
    for (const gpsOrder of fulfilledGpsOrders) {
      const platformOrderNo = gpsOrder.platformOrderNo;
      
      if (!platformOrderNo) {
        errors.push(`GPS order ${gpsOrder.outboundOrderNo}: Missing platformOrderNo`);
        continue;
      }

      try {
        // Find Shopify order by platformOrderNo (order name)
        const orders = await shopify.searchOrdersByName(platformOrderNo);
        if (orders.length === 0) {
          errors.push(`GPS order ${gpsOrder.outboundOrderNo} (${platformOrderNo}): No matching Shopify order found`);
          continue;
        }

        const shopifyOrder = orders[0] as unknown as shopify.ShopifyOrder;
        
        // Get GPS metafield if available (optional)
        let gpsData: GpsOrderMetafield | null = null;
        try {
          gpsData = await shopify.getGpsOrderMetafield(shopifyOrder.id);
        } catch {
          // Metafield not found is okay, we can still process
        }

        // Process fulfillment
        await processFulfilledGpsOrder(
          gpsOrder,
          warehouse,
          shopifyOrder,
          gpsData
        );
        
        fulfilled.push(shopifyOrder.name);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`GPS order ${gpsOrder.outboundOrderNo} (${platformOrderNo}): ${msg}`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`${warehouse}: ${msg}`);
  }

  return { fulfilled, errors, skippedCount: 0 };
}

async function processFulfilledGpsOrder(
  gpsOrder: any, // Typed as any to match GPS API response structure
  warehouseName: GpsWarehouseName,
  shopifyOrder: shopify.ShopifyOrder,
  gpsData: GpsOrderMetafield | null
): Promise<void> {
  const gpsOrderId = gpsData?.gpsOrderId || gpsOrder.outboundOrderNo;
  console.log(`[GPS Sync] Processing fulfilled order: ${shopifyOrder.name} (GPS: ${gpsOrderId})`);

  // 1. Get fulfillment orders from Shopify
  const fulfillmentOrders = await shopify.getFulfillmentOrders(shopifyOrder.id);
  const openFulfillment = fulfillmentOrders.find(
    (fo) => fo.status === "open" || fo.status === "in_progress"
  );

  if (!openFulfillment) {
    console.log(`[GPS Sync] No open fulfillment found for ${shopifyOrder.name}, skipping`);
    return;
  }

  // 2. Create Shopify fulfillment with tracking info
  const trackingUrl = getTrackingUrl(gpsOrder.logisticsCarrier, gpsOrder.logisticsTrackNo);
  
  const lineItems = openFulfillment.line_items.map((item) => ({
    id: item.id,
    quantity: item.fulfillable_quantity,
  }));

  await shopify.createFulfillment(
    openFulfillment.id,
    {
      number: gpsOrder.logisticsTrackNo,
      company: mapGpsCarrierToShopify(gpsOrder.logisticsCarrier),
      url: trackingUrl,
    },
    lineItems
  );

  // 3. Sync to D365
  if (config.features.enableDynamicsSync) {
    // Use H007 for GPS UK Warehouse, U001 for US and others
    const dataAreaId = warehouseName === "GPS UK Warehouse" ? "H007" : "U001";
    
    // Find D365 order (use order name, not ID, since THK_ShopifyReference stores the order name)
    const d365Order = await dynamics.getSalesOrderByShopifyId(
      shopifyOrder.name, // Use order name, not ID
      dataAreaId
    );

    if (d365Order?.SalesOrderNumber) {
      const lineItemsFiltered = filterDummySkus(shopifyOrder.line_items);

      // Get lotId mapping from D365 sales order lines
      const lotIdMap = await dynamics.getLotIdMap(d365Order.SalesOrderNumber, dataAreaId);

      await dynamics.createFulfilment({
        salesOrderNumber: d365Order.SalesOrderNumber,
        dataAreaId,
        type: "PackingSlip",
        confirmedShippedDate: gpsOrder.outboundTime?.split("T")[0] || new Date().toISOString().split("T")[0],
        lines: lineItemsFiltered.map((item) => ({
          itemNumber: item.sku,
          quantity: item.quantity,
          trackingNumber: gpsOrder.logisticsTrackNo,
          shippingSiteId: "",
          shippingWarehouseId: "",
          shippingWarehouseLocationId: "",
          lotId: lotIdMap[item.sku] || "",
        })),
      });
    }
  }
}

function getTrackingUrl(carrier: string, trackingNumber: string): string {
  const carrierLower = (carrier || "").toLowerCase();
  if (carrierLower.includes("fedex")) return `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
  if (carrierLower.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (carrierLower.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (carrierLower.includes("dhl")) return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  if (carrierLower.includes("sf")) return `https://www.sf-express.com/en/dynamic_function/waybill/#search/bill-number/${trackingNumber}`;
  return `https://track.aftership.com/${trackingNumber}`;
}

function mapGpsCarrierToShopify(gpsCarrier: string): string {
  const carrierMap: Record<string, string> = {
    "FEDEX-IP": "FedEx", "FEDEX-GROUND": "FedEx", "FEDEX": "FedEx",
    "UPS-GROUND": "UPS", "UPS": "UPS",
    "USPS": "USPS",
    "DHL-EXPRESS": "DHL Express", "DHL": "DHL Express",
    "SF-EXPRESS": "SF Express", "SF": "SF Express",
  };
  return carrierMap[(gpsCarrier || "").toUpperCase()] || gpsCarrier;
}
