// ============================================================================
// EXTENSIV FULFILLMENT PROCESSOR
// ============================================================================
// Processes Extensiv OrderConfirm webhooks to create Shopify and D365 fulfillments
// Flow: Extensiv ships → webhook → Shopify fulfillment → D365 packing slip

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import type {
  IShopifyFulfillmentOrder,
  IFulfillmentOrderLineItem,
  ILineItem,
} from "@/lib/types/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import { ExtensivOrderConfirmPayload } from "../events";
import { filterDummySkus } from "@/lib/utils/validation";
import { THROTTLE_CONFIGS, RETRY_CONFIGS, CONCURRENCY_CONFIGS } from "@/lib/utils/constants";
import { fetchD365InventoryLotsByShopifyOrder } from "@/lib/services/supabase-order-lookup";

export const processExtensivFulfillment = inngest.createFunction(
  {
    id: "process-extensiv-fulfillment",
    name: "Process Extensiv Fulfillment",
    throttle: THROTTLE_CONFIGS.FULFILLMENT,
    retries: RETRY_CONFIGS.STANDARD,
    concurrency: CONCURRENCY_CONFIGS.STANDARD,
    triggers: [{ event: "extensiv/order.confirm" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const {
      wmsEventId,
      extensivOrderId,
      shopifyOrderName,
      trackingNumber,
      carrier,
      dataAreaId,
      eventJson,
    } = event.data;

    const orderConfirm = eventJson as ExtensivOrderConfirmPayload;

    console.log(
      `[Extensiv] Processing fulfillment for ${shopifyOrderName} (Extensiv ID: ${extensivOrderId})`
    );

    if (!config.features.enableExtensivSync) {
      return {
        status: "skipped",
        reason: "Extensiv sync disabled",
        shopifyOrderName,
      };
    }

    // 1. Find Shopify order by name (referenceNum)
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      const orders = await shopify.searchOrdersByName(shopifyOrderName);
      if (!orders || orders.length === 0) {
        throw new Error(`Shopify order ${shopifyOrderName} not found`);
      }
      return orders[0];
    });

    const shopifyOrderId = shopifyOrder.id;

    // 2. Check if order is cancelled
    if (shopifyOrder.cancelled_at) {
      console.log(`[Extensiv] Order ${shopifyOrderName} is cancelled, skipping fulfillment`);
      return {
        status: "skipped",
        reason: "Order is cancelled",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // 3. Get fulfillment orders from Shopify
    const fulfillmentOrders = await step.run("get-fulfillment-orders", async () => {
      return shopify.getFulfillmentOrders(shopifyOrderId);
    });

    const openFulfillmentOrder = fulfillmentOrders.find(
      (fo: IShopifyFulfillmentOrder) => fo.status === "open" || fo.status === "in_progress"
    );

    if (!openFulfillmentOrder) {
      console.log(`[Extensiv] No open fulfillment order for ${shopifyOrderName}`);
      return {
        status: "skipped",
        reason: "No open fulfillment order (already fulfilled)",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    // 4. Create Shopify fulfillment
    const shopifyFulfillment = await step.run("create-shopify-fulfillment", async () => {
      const lineItems = openFulfillmentOrder.line_items.map((item: IFulfillmentOrderLineItem) => ({
        id: item.id,
        quantity: item.fulfillable_quantity,
      }));

      const trackingUrl = getTrackingUrl(carrier, trackingNumber);

      return shopify.createFulfillment(
        openFulfillmentOrder.id,
        {
          number: trackingNumber,
          company: mapExtensivCarrierToShopify(carrier),
          url: trackingUrl,
        },
        lineItems
      );
    });

    console.log(
      `[Extensiv] Created Shopify fulfillment ${shopifyFulfillment.id} for ${shopifyOrderName}`
    );

    // 5. Sync to Dynamics 365
    let d365Result: { status: string; salesOrderNumber?: string } = {
      status: "skipped",
    };

    if (config.features.enableDynamicsSync) {
      d365Result = await step.run("sync-to-dynamics", async () => {
        // Find D365 order
        // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
        const d365Order = await dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);

        if (!d365Order?.SalesOrderNumber) {
          console.warn(`[Extensiv] D365 order not found for Shopify order ${shopifyOrderId}`);
          return { status: "not_found" };
        }

        // Filter dummy SKUs
        const lineItemsFiltered = filterDummySkus(shopifyOrder.line_items) as ILineItem[];

        const supabaseLotMap = await fetchD365InventoryLotsByShopifyOrder(
          String(shopifyOrderId),
          shopifyOrderName
        );
        let lotIdMap = dynamics.mergeLotIdMaps(
          await dynamics.getLotIdMap(d365Order.SalesOrderNumber, dataAreaId),
          supabaseLotMap
        );
        const buildLines = () =>
          lineItemsFiltered.map((item: ILineItem) => ({
            itemNumber: item.sku,
            quantity: item.quantity,
            trackingNumber,
            shippingSiteId: "",
            shippingWarehouseId: "",
            shippingWarehouseLocationId: "",
            lotId: lotIdMap[String(item.sku || "").trim().toUpperCase()] || "",
          }));

        let lines = buildLines();
        const missingLotIdSkus = lines
          .filter((line) => !String(line.lotId || "").trim())
          .map((line) => line.itemNumber);
        if (missingLotIdSkus.length > 0) {
          console.warn(
            `[Extensiv][LotIdDebug] Missing lot IDs before fulfilment call: ${JSON.stringify({
              shopifyOrderName,
              salesOrderNumber: d365Order.SalesOrderNumber,
              dataAreaId,
              lotMapKeys: Object.keys(lotIdMap),
              missingLotIdSkus,
            })}`
          );
          lotIdMap = dynamics.mergeLotIdMaps(
            await dynamics.getLotIdMap(d365Order.SalesOrderNumber, dataAreaId),
            lotIdMap
          );
          lines = buildLines();
        }

        // Create D365 packing slip
        await dynamics.createFulfilment({
          salesOrderNumber: d365Order.SalesOrderNumber,
          dataAreaId,
          type: "shipment",
          confirmedShippedDate: new Date().toISOString().split("T")[0],
          lines,
        });

        console.log(`[Extensiv] Created D365 packing slip for ${d365Order.SalesOrderNumber}`);

        return {
          status: "success",
          salesOrderNumber: d365Order.SalesOrderNumber,
        };
      });
    }

    // 6. Send success notification
    await slack.sendInfoMessage(
      "extensiv",
      `✅ Extensiv fulfillment processed: ${shopifyOrderName} | Tracking: ${trackingNumber} | Carrier: ${carrier}`
    );

    return {
      status: "success",
      wmsEventId,
      extensivOrderId,
      shopifyOrderId,
      shopifyOrderName,
      shopifyFulfillmentId: shopifyFulfillment.id,
      trackingNumber,
      carrier,
      d365: d365Result,
    };
  }
);

// Process Extensiv receiver confirmations (returns)
export const processExtensivReceiverConfirm = inngest.createFunction(
  {
    id: "process-extensiv-receiver-confirm",
    name: "Process Extensiv Receiver Confirm",
    throttle: THROTTLE_CONFIGS.FULFILLMENT,
    retries: RETRY_CONFIGS.STANDARD,
    concurrency: CONCURRENCY_CONFIGS.STANDARD,
    triggers: [{ event: "extensiv/receiver.confirm" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { wmsEventId, receiverId, referenceNum, eventJson } = event.data;

    console.log(
      `[Extensiv] Processing receiver confirm for ${referenceNum} (Receiver ID: ${receiverId})`
    );

    if (!config.features.enableExtensivSync) {
      return {
        status: "skipped",
        reason: "Extensiv sync disabled",
        referenceNum,
      };
    }

    // Receiver confirms are typically for returns
    // The referenceNum might be an RMA number from Loop or similar
    // For now, we just acknowledge and log

    await slack.sendInfoMessage(
      "extensiv",
      `📦 Extensiv receiver confirmed: ${referenceNum} | Receiver ID: ${receiverId}`
    );

    return {
      status: "acknowledged",
      wmsEventId,
      receiverId,
      referenceNum,
      note: "Receiver confirmation logged. Integration with Loop returns can be added here.",
    };
  }
);

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

function mapExtensivCarrierToShopify(carrier: string): string {
  const carrierMap: Record<string, string> = {
    FEDEX: "FedEx",
    "FEDEX-IP": "FedEx",
    "FEDEX-GROUND": "FedEx",
    UPS: "UPS",
    "UPS-GROUND": "UPS",
    USPS: "USPS",
    DHL: "DHL Express",
    "DHL-EXPRESS": "DHL Express",
    "SF-EXPRESS": "SF Express",
    SF: "SF Express",
  };
  return carrierMap[(carrier || "").toUpperCase()] || carrier;
}
