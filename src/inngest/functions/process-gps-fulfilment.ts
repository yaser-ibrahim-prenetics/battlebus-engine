// ============================================================================
// INNGEST FUNCTION: Process GPS Fulfilment
// ============================================================================
// This replaces the old "gps" task type from spock-store
// Handles fulfilment notifications from GPS warehouse

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import type { GpsFulfilmentPayload } from "../events";

// Carrier code mapping (from spock-store)
const CARRIER_MAPPING: Record<string, string> = {
  USPS: "USPS",
  UPS: "UPS",
  FEDEX: "FedEx",
  DHL: "DHL",
  // Add more mappings as needed
};

export const processGpsFulfilment = inngest.createFunction(
  {
    id: "process-gps-fulfilment",
    name: "Process GPS Fulfilment",
    // Idempotency: Prevent duplicate processing of the same fulfilment
    idempotency: "event.data.gpsOrderId + '-' + event.data.trackingNumber",
    retries: 5,

    // =========================================================================
    // THROTTLING: Prevent overwhelming Shopify Fulfillment API
    // Shopify has rate limits of ~2 requests/second for REST API
    // =========================================================================
    throttle: {
      limit: 2,
      period: "1s",
    },

    // =========================================================================
    // KEY-BASED CONCURRENCY: Prevent race conditions
    // Only 1 fulfilment processed at a time per Shopify order
    // This prevents duplicate fulfillments for the same order
    // =========================================================================
    concurrency: [
      {
        limit: 1, // Strict: 1 fulfilment at a time per order
        key: "event.data.shopifyOrderId",
      },
    ],

    // =========================================================================
    // RATE LIMIT: Fraud protection - max 5 fulfilments per order per day
    // =========================================================================
    rateLimit: {
      key: "event.data.shopifyOrderId",
      limit: 5,
      period: "24h",
    },
  },
  { event: "gps/fulfilment.received" },
  async ({ event, step }) => {
    const { gpsOrderId, shopifyOrderId, trackingNumber, carrierCode, fulfilmentJson } = event.data;

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        gpsOrderId,
        trackingNumber,
      };
    }

    // =========================================================================
    // STEP 1: Get Shopify Order Details
    // =========================================================================
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      return shopify.getOrder(shopifyOrderId);
    });

    // =========================================================================
    // STEP 2: Get Shopify Fulfillment Orders
    // =========================================================================
    const fulfillmentOrders = await step.run("get-fulfillment-orders", async () => {
      return shopify.getFulfillmentOrders(shopifyOrderId);
    });

    // Find the open fulfillment order
    const openFulfillmentOrder = fulfillmentOrders.find(
      (fo) => fo.status === "open" || fo.status === "in_progress"
    );

    if (!openFulfillmentOrder) {
      return {
        status: "no_open_fulfillment_order",
        shopifyOrderId,
        shopifyOrderName: shopifyOrder.name,
      };
    }

    // =========================================================================
    // STEP 3: Create Shopify Fulfillment
    // =========================================================================
    const shopifyFulfillment = await step.run("create-shopify-fulfillment", async () => {
      const carrierName = CARRIER_MAPPING[carrierCode] || carrierCode;

      // Map GPS items to Shopify line items
      const fulfilment = fulfilmentJson as GpsFulfilmentPayload;
      const lineItems = mapGpsItemsToShopifyLineItems(
        fulfilment.items,
        openFulfillmentOrder.line_items
      );

      return shopify.createFulfillment(
        openFulfillmentOrder.id,
        {
          number: trackingNumber,
          company: carrierName,
          url: getTrackingUrl(carrierCode, trackingNumber),
        },
        lineItems
      );
    });

    // =========================================================================
    // STEP 4: Create D365 Packing Slip
    // =========================================================================
    await step.run("create-d365-packing-slip", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      // Get D365 order
      const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      if (!d365Order) {
        return;
      }

      const fulfilment = fulfilmentJson as GpsFulfilmentPayload;

      // Use dataAreaId from D365 order, fallback to config
      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      await dynamics.createFulfilment({
        dataAreaId,
        salesOrderNumber: d365Order.SalesOrderNumber!,
        type: "PackingSlip",
        confirmedShippedDate: fulfilment.shippedDate || new Date().toISOString().split("T")[0],
        lines: fulfilment.items.map((item) => ({
          itemNumber: item.sku,
          quantity: item.quantity,
          shippingSiteId: "Prenetics",
          trackingNumber: trackingNumber,
        })),
      });
    });

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
    return {
      status: "success",
      gpsOrderId,
      shopifyOrderId,
      shopifyOrderName: shopifyOrder.name,
      trackingNumber,
      shopifyFulfillmentId: shopifyFulfillment.id,
      processedAt: new Date().toISOString(),
    };
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function mapGpsItemsToShopifyLineItems(
  gpsItems: { sku: string; quantity: number }[],
  shopifyLineItems: shopify.ShopifyFulfillmentOrderLineItem[]
): { id: number; quantity: number }[] {
  // Simple mapping - in production, you'd match by SKU
  return shopifyLineItems.map((item) => ({
    id: item.id,
    quantity: item.fulfillable_quantity,
  }));
}

function getTrackingUrl(carrierCode: string, trackingNumber: string): string {
  const urls: Record<string, string> = {
    USPS: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    UPS: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    FEDEX: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
    DHL: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
  };

  return urls[carrierCode] || `https://track.aftership.com/${trackingNumber}`;
}
