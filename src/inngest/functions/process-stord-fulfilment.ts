import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import type { StordFulfilmentPayload } from "../events";

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
    idempotency: "event.data.stordOrderId + '-' + event.data.trackingNumber",
    retries: 5,
    throttle: {
      limit: 2,
      period: "1s",
    },
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      key: "event.data.shopifyOrderId",
      limit: 5,
      period: "24h",
    },
  },
  { event: "stord/fulfilment.received" },
  async ({ event, step }) => {
    const { stordOrderId, shopifyOrderId, trackingNumber, carrierCode, fulfilmentJson } = event.data;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        stordOrderId,
        trackingNumber,
      };
    }

    const shopifyOrder = await step.run("get-shopify-order", async () => {
      return shopify.getOrder(shopifyOrderId);
    });

    const fulfillmentOrders = await step.run("get-fulfillment-orders", async () => {
      return shopify.getFulfillmentOrders(shopifyOrderId);
    });

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

    await step.run("create-d365-packing-slip", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      if (!d365Order) {
        return;
      }

      const fulfilment = fulfilmentJson as StordFulfilmentPayload;
      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;

      await dynamics.createFulfilment({
        dataAreaId,
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
