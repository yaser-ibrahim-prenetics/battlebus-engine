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
// - Filters for orders fulfilled in the last 6 hours (based on outboundTime)
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

    // 1. Get Unfulfilled Orders with GPS metafields from Shopify
    // Only orders that have been sent to GPS will have the metafield
    // Use default parameters (limit=250, daysBack=30) to catch older orders
    const gpsOrders = await step.run("get-unfulfilled-gps-orders", async () => {
      return shopify.getUnfulfilledGpsOrders();
    });

    if (gpsOrders.length === 0) {
      return { status: "success", message: "No unfulfilled GPS orders found" };
    }

    console.log(`[GPS Sync] Found ${gpsOrders.length} unfulfilled orders with GPS metafields`);

    const processedBatches = [];
    const orderChunks = [];
    for (let i = 0; i < gpsOrders.length; i += BATCH_SIZE) {
      orderChunks.push(gpsOrders.slice(i, i + BATCH_SIZE));
    }

    // 2. Process each chunk as a separate step
    for (let i = 0; i < orderChunks.length; i++) {
      const chunk = orderChunks[i];
      const batchResult = await step.run(`process-batch-${i + 1}`, async () => {
        return processOrderBatch(chunk);
      });
      processedBatches.push(batchResult);
    }

    const totalFulfilled = processedBatches.reduce((sum, b) => sum + b.fulfilled.length, 0);
    const totalErrors = processedBatches.reduce((sum, b) => sum + b.errors.length, 0);
    const allFulfilledOrderIds = processedBatches.flatMap((b) => b.fulfilled);

    // Log summary of GPS orders with status 3
    if (totalFulfilled > 0) {
      console.log(
        `[GPS Sync] Summary: Found ${totalFulfilled} GPS orders with status 3 (FULFILLED) across all batches`
      );
      console.log(
        `[GPS Sync] All fulfilled order IDs: ${allFulfilledOrderIds.join(", ")}`
      );
    } else {
      console.log(`[GPS Sync] Summary: No GPS orders with status 3 (FULFILLED) found`);
    }

    if (totalFulfilled > 0 || totalErrors > 0) {
      await slack.sendInfoMessage(
        "gps",
        `GPS Sync: ${totalFulfilled} fulfilled, ${totalErrors} errors out of ${gpsOrders.length} checked.`
      );
    }

    return {
      status: "completed",
      checked: gpsOrders.length,
      fulfilled: totalFulfilled,
      fulfilledOrderIds: allFulfilledOrderIds,
      batches: processedBatches,
    };
  }
);

// Order type with GPS metafield data attached
type GpsTrackedOrder = shopify.ShopifyOrder & { gpsData: GpsOrderMetafield };

async function processOrderBatch(orders: GpsTrackedOrder[]) {
  const fulfilled: string[] = [];
  const errors: string[] = [];

  // Group orders by warehouse using the metafield data (no need to check location IDs)
  const warehouseMap: Record<GpsWarehouseName, Array<{
    shopifyOrder: shopify.ShopifyOrder;
    gpsData: GpsOrderMetafield;
  }>> = {
    "GPS Warehouse": [],
    "GPS UK Warehouse": [],
  };

  // 1. Group orders by warehouse from metafield data
  for (const order of orders) {
    const warehouse = order.gpsData.warehouse as GpsWarehouseName;
    if (warehouse === "GPS Warehouse" || warehouse === "GPS UK Warehouse") {
      warehouseMap[warehouse].push({
        shopifyOrder: order,
        gpsData: order.gpsData,
      });
      console.log(`[GPS Sync] Order ${order.name} -> ${warehouse} (GPS ID: ${order.gpsData.gpsOrderId})`);
    } else {
      errors.push(`${order.name}: Unknown warehouse "${warehouse}" in metafield`);
    }
  }

  // 2. Check GPS Status for each warehouse group
  for (const warehouse of ["GPS Warehouse", "GPS UK Warehouse"] as GpsWarehouseName[]) {
    const warehouseOrders = warehouseMap[warehouse];
    if (warehouseOrders.length === 0) continue;

    // Use GPS order IDs (from metafield) to query GPS API
    const gpsOrderIds = warehouseOrders.map(o => o.gpsData.gpsOrderId);
    
    console.log(`[GPS Sync] [${warehouse}] Querying GPS for ${gpsOrderIds.length} orders: ${gpsOrderIds.join(", ")}`);
    
    try {
      // Query GPS using the actual GPS order IDs (outboundOrderNoList)
      const { response } = await gps.getOutboundOrdersDetails(gpsOrderIds, warehouse);

      if (!response.data || response.code !== 200) {
        errors.push(`${warehouse}: API error - ${response.msg}`);
        continue;
      }

      console.log(`[GPS Sync] [${warehouse}] GPS returned ${response.data.length} orders`);

      // 3. Filter for fulfilled orders (status 3) fulfilled in the last 6 hours
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

      // 4. Process Fulfilled Orders using platformOrderNo from GPS
      for (const gpsOrder of fulfilledGpsOrders) {
        // Use platformOrderNo from GPS response to find Shopify order
        // platformOrderNo should match the Shopify order name (e.g., "IM8-15116")
        const platformOrderNo = gpsOrder.platformOrderNo;
        
        if (!platformOrderNo) {
          errors.push(`GPS order ${gpsOrder.outboundOrderNo}: Missing platformOrderNo`);
          continue;
        }

        // Try to find Shopify order by name (platformOrderNo)
        let shopifyOrder: shopify.ShopifyOrder | null = null;
        let gpsData: GpsOrderMetafield | null = null;
        
        // First, try to find in the current batch
        const matchedOrder = warehouseOrders.find(
          o => o.shopifyOrder.name === platformOrderNo
        );
        
        if (matchedOrder) {
          shopifyOrder = matchedOrder.shopifyOrder;
          gpsData = matchedOrder.gpsData;
        } else {
          // If not in batch, fetch from Shopify by order name (platformOrderNo)
          try {
            // Search for order by name (platformOrderNo)
            const orders = await shopify.searchOrdersByName(platformOrderNo);
            if (orders.length > 0) {
              // Cast IShopifyOrder to ShopifyOrder (they're compatible)
              shopifyOrder = orders[0] as unknown as shopify.ShopifyOrder;
              // Try to get GPS metafield if available
              const metafield = await shopify.getGpsOrderMetafield(shopifyOrder.id);
              if (metafield) {
                gpsData = metafield;
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            errors.push(`GPS order ${gpsOrder.outboundOrderNo} (${platformOrderNo}): Failed to fetch from Shopify - ${msg}`);
            continue;
          }
        }
        
        if (!shopifyOrder) {
          errors.push(`GPS order ${gpsOrder.outboundOrderNo} (${platformOrderNo}): No matching Shopify order found`);
          continue;
        }

        try {
          await processFulfilledGpsOrder(
            gpsOrder,
            warehouse,
            shopifyOrder,
            gpsData // May be null if not found, but that's okay
          );
          fulfilled.push(shopifyOrder.name);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${shopifyOrder.name}: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${warehouse}: ${msg}`);
    }
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
