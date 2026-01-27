// ============================================================================
// GPS FULFILLMENT SYNC (Scheduled Polling)
// ============================================================================
// Polls GPS warehouse API for fulfilled orders and syncs to Shopify + D365
// Serverless-friendly: splits processing into small batches

import { inngest } from "../client";
import { config, GPS_STATUS } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import * as shopify from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import {
  getGpsWarehouseFromLocation,
  filterDummySkus,
} from "@/lib/utils/validation";
import { THROTTLE_CONFIGS } from "@/lib/utils/constants";

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

// Process orders in small batches to avoid serverless timeouts
// Fetching fulfillment orders for 10 orders + GPS API calls should fit within standard timeouts
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

    // 1. Get Unfulfilled Orders from Shopify
    // We fetch a larger pool to work through
    const unfulfilledOrders = await step.run("get-unfulfilled-orders", async () => {
      return shopify.getUnfulfilledOrders(50); // Start with 50 to be safe
    });

    if (unfulfilledOrders.length === 0) {
      return { status: "success", message: "No unfulfilled orders found" };
    }

    const processedBatches = [];
    const orderChunks = [];
    for (let i = 0; i < unfulfilledOrders.length; i += BATCH_SIZE) {
      orderChunks.push(unfulfilledOrders.slice(i, i + BATCH_SIZE));
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
        `GPS Sync: ${totalFulfilled} fulfilled, ${totalErrors} errors out of ${unfulfilledOrders.length} checked.`
      );
    }

    return {
      status: "completed",
      checked: unfulfilledOrders.length,
      fulfilled: totalFulfilled,
      fulfilledOrderIds: allFulfilledOrderIds,
      batches: processedBatches,
    };
  }
);

async function processOrderBatch(orders: shopify.ShopifyOrder[]) {
  const fulfilled: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];

  // Group by warehouse
  const warehouseMap: Record<GpsWarehouseName, Array<{ name: string; id: number }>> = {
    "GPS Warehouse": [],
    "GPS UK Warehouse": [],
  };

  // 1. Identify GPS Orders
  for (const order of orders) {
    try {
      const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
      
      // Find which warehouse this order is assigned to
      let assignedWarehouse: GpsWarehouseName | null = null;
      
      for (const fo of fulfillmentOrders) {
        if (fo.status !== 'open' && fo.status !== 'in_progress') continue;
        
        const warehouse = getGpsWarehouseFromLocation(
          fo.assigned_location_id || fo.assigned_location?.id || ""
        );
        
        if (warehouse) {
          assignedWarehouse = warehouse;
          break; // Found primary GPS location
        }
      }

      if (assignedWarehouse) {
        warehouseMap[assignedWarehouse].push({ name: order.name, id: order.id });
      } else {
        skipped.push(order.name);
      }
    } catch (error) {
      errors.push(`${order.name}: Failed to get fulfillment orders - ${error}`);
    }
  }

  // 2. Check GPS Status for each warehouse group
  for (const warehouse of ["GPS Warehouse", "GPS UK Warehouse"] as GpsWarehouseName[]) {
    const gpsOrders = warehouseMap[warehouse];
    if (gpsOrders.length === 0) continue;

    const orderNames = gpsOrders.map(o => o.name);
    
    try {
      const { response } = await gps.getOutboundOrdersDetails(orderNames, warehouse);

      if (!response.data || response.code !== 200) {
        errors.push(`${warehouse}: API error - ${response.msg}`);
        continue;
      }

      // 3. Filter and log GPS orders with status 3 (FULFILLED)
      const fulfilledOrders = response.data.filter(
        (gpsOrder) => gpsOrder.status === GPS_STATUS.FULFILLED
      );

      if (fulfilledOrders.length > 0) {
        const fulfilledOrderIds = fulfilledOrders.map((order) => order.platformOrderNo);
        console.log(
          `[GPS Sync] [${warehouse}] Found ${fulfilledOrders.length} GPS orders with status 3 (FULFILLED):`
        );
        console.log(
          `[GPS Sync] [${warehouse}] Order IDs: ${fulfilledOrderIds.join(", ")}`
        );
      }

      // 4. Process Fulfilled Orders
      for (const gpsOrder of fulfilledOrders) {
        try {
          await processFulfilledGpsOrder(gpsOrder, warehouse, gpsOrders);
          fulfilled.push(gpsOrder.platformOrderNo);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${gpsOrder.platformOrderNo}: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${warehouse}: ${msg}`);
    }
  }

  return { fulfilled, errors, skippedCount: skipped.length };
}

async function processFulfilledGpsOrder(
  gpsOrder: any, // Typed as any to match response structure
  warehouseName: GpsWarehouseName,
  orderLookup: Array<{ name: string; id: number }>
): Promise<void> {
  const orderInfo = orderLookup.find((o) => o.name === gpsOrder.platformOrderNo);
  if (!orderInfo) return;

  // 1. Get fulfillment orders
  const fulfillmentOrders = await shopify.getFulfillmentOrders(orderInfo.id);
  const openFulfillment = fulfillmentOrders.find(
    (fo) => fo.status === "open" || fo.status === "in_progress"
  );

  if (!openFulfillment) return;

  // 2. Create Shopify fulfillment
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
    const dataAreaId = warehouseName === "GPS UK Warehouse" ? "U007" : "U001";
    
    // Find D365 order (use order name, not ID, since THK_ShopifyReference stores the order name)
    const d365Order = await dynamics.getSalesOrderByShopifyId(
      orderInfo.name, // Use order name, not ID
      dataAreaId
    );

    if (d365Order?.SalesOrderNumber) {
      const shopifyOrder = await shopify.getOrder(orderInfo.id);
      const lineItemsFiltered = filterDummySkus(shopifyOrder.line_items);

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
          lotId: "",
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
