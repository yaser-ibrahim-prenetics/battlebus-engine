import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import type { GpsFulfilmentPayload } from "../events";

const CARRIER_MAPPING: Record<string, string> = {
  USPS: "USPS",
  UPS: "UPS",
  FEDEX: "FedEx",
  DHL: "DHL",
};

export const processGpsFulfilment = inngest.createFunction(
  {
    id: "process-gps-fulfilment",
    name: "Process GPS Fulfilment",
    idempotency: "event.data.gpsOrderId + '-' + event.data.trackingNumber",
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
  { event: "gps/fulfilment.received" },
  async ({ event, step }) => {
    const { gpsOrderId, shopifyOrderId, trackingNumber, carrierCode, fulfilmentJson } = event.data;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        gpsOrderId,
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
      const carrierName = CARRIER_MAPPING[carrierCode] || carrierCode;
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

    await step.run("create-d365-packing-slip", async () => {
      if (!config.features.enableDynamicsSync) {
        return;
      }

      const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrderId);
      if (!d365Order) {
        return;
      }

      const fulfilment = fulfilmentJson as GpsFulfilmentPayload;
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

function mapGpsItemsToShopifyLineItems(
  gpsItems: { sku: string; quantity: number }[],
  shopifyLineItems: shopify.ShopifyFulfillmentOrderLineItem[]
): { id: number; quantity: number }[] {
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
