// ============================================================================
// INNGEST FUNCTION: Process STORD Fulfilment
// ============================================================================
// Handles fulfilment notifications from STORD warehouse

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import type { StordFulfilmentPayload } from "../events";

// Carrier code mapping for STORD
const CARRIER_MAPPING: Record<string, string> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL",
  ontrac: "OnTrac",
  lasership: "LaserShip",
};

export const processStordFulfilment = inngest.createFunction(
  {
    id: "process-stord-fulfilment",
    name: "Process STORD Fulfilment",
    // Idempotency: Prevent duplicate processing
    idempotency: "event.data.stordOrderId + '-' + event.data.trackingNumber",
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
  { event: "stord/fulfilment.received" },
  async ({ event, step }) => {
    const { stordOrderId, shopifyOrderId, trackingNumber, carrierCode, fulfilmentJson } = event.data;

    console.log(`[Battle Bus] Processing STORD fulfilment: ${stordOrderId} -> ${trackingNumber}`);

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      console.log(`[Dry Run] Would process STORD fulfilment: ${stordOrderId}`);
      return {
        status: "dry_run",
        stordOrderId,
        trackingNumber,
      };
    }

    // =========================================================================
    // STEP 1: Get Shopify Order Details
    // =========================================================================
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      return shopify.getOrder(shopifyOrderId);
    });

    console.log(`[Battle Bus] Found Shopify order: ${shopifyOrder.name}`);

    // =========================================================================
    // STEP 2: Get Shopify Fulfillment Orders
    // =========================================================================
    const fulfillmentOrders = await step.run("get-fulfillment-orders", async () => {
      return shopify.getFulfillmentOrders(shopifyOrderId);
    });

    const openFulfillmentOrder = fulfillmentOrders.find(
      (fo) => fo.status === "open" || fo.status === "in_progress"
    );

    if (!openFulfillmentOrder) {
      console.log(`[Battle Bus] No open fulfillment order found for: ${shopifyOrder.name}`);
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
      const carrierName = CARRIER_MAPPING[carrierCode.toLowerCase()] || carrierCode;

      const fulfilment = fulfilmentJson as StordFulfilmentPayload;
      const lineItems = mapStordItemsToShopifyLineItems(
        fulfilment.lineItems,
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

    console.log(`[Battle Bus] Created Shopify fulfillment: ${shopifyFulfillment.id}`);

    // =========================================================================
    // STEP 4: Create D365 Packing Slip
    // =========================================================================
    await step.run("create-d365-packing-slip", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      if (!d365Order) {
        console.log(`[Battle Bus] No D365 order found for: ${shopifyOrderId}`);
        return;
      }

      const fulfilment = fulfilmentJson as StordFulfilmentPayload;

      await dynamics.createFulfilment({
        dataAreaId: config.dynamics.dataAreaId,
        salesOrderNumber: d365Order.SalesOrderNumber!,
        type: "PackingSlip",
        confirmedShippedDate: fulfilment.shippedAt?.split("T")[0] || new Date().toISOString().split("T")[0],
        lines: fulfilment.lineItems.map((item) => ({
          itemNumber: item.sku,
          quantity: item.quantity,
          shippingSiteId: "Prenetics",
          trackingNumber: trackingNumber,
        })),
      });
    });

    console.log(`[Battle Bus] Created D365 packing slip for: ${shopifyOrder.name}`);

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
    return {
      status: "success",
      stordOrderId,
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

function mapStordItemsToShopifyLineItems(
  stordItems: { sku: string; quantity: number }[],
  shopifyLineItems: shopify.ShopifyFulfillmentOrderLineItem[]
): { id: number; quantity: number }[] {
  return shopifyLineItems.map((item) => ({
    id: item.id,
    quantity: item.fulfillable_quantity,
  }));
}

function getTrackingUrl(carrierCode: string, trackingNumber: string): string {
  const carrier = carrierCode.toLowerCase();
  const urls: Record<string, string> = {
    usps: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    ups: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    fedex: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
    dhl: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    ontrac: `https://www.ontrac.com/tracking/?number=${trackingNumber}`,
    lasership: `https://www.lasership.com/track/${trackingNumber}`,
  };

  return urls[carrier] || `https://track.aftership.com/${trackingNumber}`;
}
