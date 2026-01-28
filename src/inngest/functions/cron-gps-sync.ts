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

      // 3. Filter for fulfilled orders (status 3)
      const fulfilledGpsOrders = response.data.filter(
        (gpsOrder) => gpsOrder.status === GPS_STATUS.FULFILLED
      );

      if (fulfilledGpsOrders.length > 0) {
        console.log(
          `[GPS Sync] [${warehouse}] Found ${fulfilledGpsOrders.length} fulfilled orders`
        );
      }

      // 4. Process Fulfilled Orders
      for (const gpsOrder of fulfilledGpsOrders) {
        // Find the matching Shopify order by GPS order ID (outboundOrderNo in response)
        const matchedOrder = warehouseOrders.find(
          o => o.gpsData.gpsOrderId === gpsOrder.outboundOrderNo
        );
        
        if (!matchedOrder) {
          errors.push(`GPS order ${gpsOrder.outboundOrderNo}: No matching Shopify order found`);
          continue;
        }

        try {
          await processFulfilledGpsOrder(
            gpsOrder,
            warehouse,
            matchedOrder.shopifyOrder,
            matchedOrder.gpsData
          );
          fulfilled.push(matchedOrder.shopifyOrder.name);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${matchedOrder.shopifyOrder.name}: ${msg}`);
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
  gpsData: GpsOrderMetafield
): Promise<void> {
  console.log(`[GPS Sync] Processing fulfilled order: ${shopifyOrder.name} (GPS: ${gpsData.gpsOrderId})`);

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

  console.log(`[GPS Sync] Created Shopify fulfillment for ${shopifyOrder.name}`);

  // 3. Sync to D365 (create packing slip)
  if (config.features.enableDynamicsSync) {
    const dataAreaId = warehouseName === "GPS UK Warehouse" ? "U001" : "U001";
    
    // Use D365 order number from metafield if available, otherwise look it up
    let d365OrderNumber = gpsData.d365OrderNumber;
    
    if (!d365OrderNumber || d365OrderNumber.startsWith("SKIP-")) {
      // Look up D365 order by Shopify order name
      const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrder.name, dataAreaId);
      d365OrderNumber = d365Order?.SalesOrderNumber || "";
    }

    if (d365OrderNumber && !d365OrderNumber.startsWith("SKIP-")) {
      const lineItemsFiltered = filterDummySkus(shopifyOrder.line_items);

      // Get lotId mapping from D365 sales order lines
      const lotIdMap = await dynamics.getLotIdMap(d365OrderNumber, dataAreaId);

      await dynamics.createFulfilment({
        salesOrderNumber: d365OrderNumber,
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

      console.log(`[GPS Sync] Created D365 packing slip for ${shopifyOrder.name} (${d365OrderNumber})`);
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
