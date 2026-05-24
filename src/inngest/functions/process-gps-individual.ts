import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { config } from "@/lib/config";
import {
  extractGpsFulfilmentData,
  getDataAreaId,
  getFulfilmentConfig,
  isValidGpsWarehouse,
} from "@/lib/helpers/warehouse";
import { filterDummySkus } from "@/lib/utils/validation";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  retryWithBackoff,
} from "@/lib/utils/constants";
import { getTrackingUrl, mapGpsCarrierToShopify } from "@/lib/helpers/tracking";

// Interfaces
import { isGpsIndividualFulfilmentPayload } from "@/lib/types/gps";
import { SlackChannelEnum } from "@/lib/types/slack";
import type { IFulfillmentOrderLineItem, ILineItem } from "@/lib/types/shopify";

// API Calls
import * as slack from "@/lib/clients/slack";
import * as shopify from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as csPlatform from "@/lib/clients/cs-platform";
import { resolveD365OrderHeaderForLifecycle } from "@/lib/services/d365-order-header-resolution";
import { fetchD365InventoryLotsByShopifyOrder } from "@/lib/services/supabase-order-lookup";
import { logFlowEvent, logFlowEventSync } from "@/lib/services/supabase-flow-logs";
import { isDepositFulfillmentOrder } from "@/lib/helpers/d365-thk-fulfilment";

// Event configuration
const processGpsIndividualConfig = Object.freeze({
  id: "process-gps-individual",
  name: "Process GPS Individual",
  idempotency: "event.data.outboundOrderNo",
  retries: RETRY_CONFIGS.DEFAULT,
  throttle: {
    ...THROTTLE_CONFIGS.GPS,
    key: "event.data.warehouse",
  },
  concurrency: CONCURRENCY_CONFIGS.FULFILLMENT,
  rateLimit: {
    ...RATE_LIMIT_CONFIGS.FULFILLMENT,
    key: "event.data.outboundOrderNo",
  },
});

export const processGpsIndividual = inngest.createFunction(
  { ...processGpsIndividualConfig, triggers: [{ event: "gps/individual.fulfilment" }] },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const { fulfilmentPayload, warehouse } = event.data;
    const _flowStart = Date.now();
    const _runId = String(runId ?? "") || undefined;

    logFlowEvent({
      flow: "gps_fulfillment",
      step: "start",
      status: "started",
      runId: _runId,
      payload: { warehouse, gpsOrderNo: event.data.gpsOrderNo },
    });

    // Step 1: Validate and extract fulfilment data
    const fulfilmentData = await step.run("validate-fulfilment-payload", async () => {
      console.log(`[GPS Individual] Processing fulfilment for warehouse: ${warehouse}`);

      // Validate payload structure
      if (!isGpsIndividualFulfilmentPayload(fulfilmentPayload)) {
        throw new NonRetriableError("Invalid GPS individual fulfilment payload structure");
      }

      // Validate warehouse
      if (!warehouse || !isValidGpsWarehouse(warehouse)) {
        throw new NonRetriableError(
          `Invalid warehouse: ${warehouse}. Must be "GPS Warehouse" or "GPS UK Warehouse".`
        );
      }

      // Extract key data
      const data = extractGpsFulfilmentData(fulfilmentPayload);

      // Validate fulfilled status
      if (data.status !== config.gps.gpsFulfilledStatus) {
        throw new NonRetriableError(
          `Order ${data.gpsOrderNo} is not fulfilled (status: ${data.status})`
        );
      }

      // Validate required fields
      if (!data.shopifyOrderName) {
        throw new NonRetriableError(
          `GPS order ${data.gpsOrderNo} is missing platformOrderNo (Shopify order name)`
        );
      }
      if (!data.trackingNumber) {
        throw new NonRetriableError(`GPS order ${data.gpsOrderNo} is missing tracking number`);
      }
      if (!data.shippedAt) {
        throw new NonRetriableError(`GPS order ${data.gpsOrderNo} is missing outboundTime`);
      }

      console.log(
        `[GPS Individual] Validated fulfilment: ${data.gpsOrderNo} -> Shopify: ${data.shopifyOrderName}, Tracking: ${data.trackingNumber}`
      );

      return data;
    });

    // Step 2: Find Shopify order by name
    const shopifyOrder = await step.run("get-shopify-order", async () => {
      console.log(
        `[GPS Individual] Searching for Shopify order: ${fulfilmentData.shopifyOrderName}`
      );

      const orders = await shopify.searchOrdersByName(fulfilmentData.shopifyOrderName);
      if (!orders || orders.length === 0) {
        throw new Error(`Shopify order not found for name: ${fulfilmentData.shopifyOrderName}`);
      }

      const order = orders[0];
      console.log(`[GPS Individual] Found Shopify order: ${order.id} (${order.name})`);
      return order;
    });

    // Step 3: Get Shopify fulfillment orders
    const fulfillmentOrder = await step.run("get-fulfillment-orders", async () => {
      console.log(
        `[GPS Individual] Getting fulfillment orders for Shopify order: ${shopifyOrder.id}`
      );
      const fulfillmentOrders = await shopify.getFulfillmentOrders(shopifyOrder.id);

      // Find open or in_progress fulfillment order
      const openFulfillment = fulfillmentOrders.find(
        (fo) => fo.status === "open" || fo.status === "in_progress"
      );

      if (!openFulfillment) {
        console.log(
          `[GPS Individual] No open fulfillment orders found - order may already be fulfilled`
        );
        return null;
      }

      console.log(`[GPS Individual] Found open fulfillment order: ${openFulfillment.id}`);
      return openFulfillment;
    });

    // Step 4: Create Shopify fulfillment (unless safety switch is on)
    const shopifyFulfillment = await step.run("create-shopify-fulfillment", async () => {
      if (!fulfillmentOrder) {
        console.log(`[GPS Individual] Skip Shopify fulfillment since no open fulfillment order`);
        return { skipped: true, reason: "No open fulfillment order" };
      }
      if (!config.features.enableShopifyFulfillmentWriteback) {
        console.warn(
          `[GPS Individual][Safety] Shopify fulfillment writeback is OFF (ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK!=true) — skip createFulfillment for ${fulfilmentData.shopifyOrderName}`
        );
        return {
          skipped: true,
          reason:
            "Shopify writeback is OFF (set ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK=true to enable)",
        };
      }

      console.log(
        `[GPS Individual] Creating Shopify fulfillment with tracking: ${fulfilmentData.trackingNumber}`
      );
      const trackingUrl = getTrackingUrl(fulfilmentData.carrier, fulfilmentData.trackingNumber);
      const carrierName = mapGpsCarrierToShopify(fulfilmentData.carrier);

      const lineItems = fulfillmentOrder.line_items.map((item: IFulfillmentOrderLineItem) => ({
        id: item.id,
        quantity: item.fulfillable_quantity,
      }));

      const fulfillment = await shopify.createFulfillment(
        fulfillmentOrder.id,
        {
          number: fulfilmentData.trackingNumber,
          company: carrierName,
          url: trackingUrl,
        },
        lineItems
      );

      console.log(`[GPS Individual] Created Shopify fulfillment: ${fulfillment.id}`);
      return { skipped: false, fulfillmentId: fulfillment.id };
    });

    // Step 5: Sync to D365 (create packing slip) — spock-store posts prepayment at order create only.
    const dynamicRecord = await step.run("sync-to-d365", async () => {
      if (!config.features.enableDynamicsSync) {
        console.log(`[GPS Individual] D365 sync is disabled`);
        return { skipped: true, reason: "D365 sync is disabled" };
      }

      // Determine data area from warehouse
      const dataAreaId = getDataAreaId(warehouse);
      console.log(`[GPS Individual] Syncing to D365 with dataAreaId: ${dataAreaId}`);

      // Use the same resolver flow as other lifecycle handlers (Supabase hint + OData fallbacks).
      const d365Order = await resolveD365OrderHeaderForLifecycle({
        shopifyOrderId: String(shopifyOrder.id),
        shopifyOrderName: fulfilmentData.shopifyOrderName || shopifyOrder.name,
        shippingCountryCode: shopifyOrder.shipping_address?.country_code,
        preferredDataAreaId: dataAreaId,
      });
      if (!d365Order?.SalesOrderNumber) {
        console.log(`[GPS Individual] D365 order not found for ${fulfilmentData.shopifyOrderName}`);
        return { skipped: true, reason: `D365 order not found ${fulfilmentData.shopifyOrderName}` };
      }
      console.log(`[GPS Individual] Found D365 order: ${d365Order.SalesOrderNumber}`);

      // Filter dummy SKUs from line items
      const lineItemsFiltered = filterDummySkus(shopifyOrder.line_items);
      if (lineItemsFiltered.length === 0) {
        console.log(`[GPS Individual] No valid line items`);
        return { skipped: true, reason: "No valid line items" };
      }

      const supabaseLotMap = await fetchD365InventoryLotsByShopifyOrder(
        String(shopifyOrder.id),
        fulfilmentData.shopifyOrderName || shopifyOrder.name
      );
      let lotIdMap = dynamics.mergeLotIdMaps(
        await dynamics.getLotIdMap(d365Order.SalesOrderNumber, dataAreaId),
        supabaseLotMap
      );
      const d365LineDimensionsMap = await dynamics.getSalesOrderLineFulfilmentDimensionsMap(
        d365Order.SalesOrderNumber,
        dataAreaId
      );
      const shippedDate =
        fulfilmentData.shippedAt?.split(" ")[0] || new Date().toISOString().split("T")[0];

      const fulfilmentConfig = getFulfilmentConfig(warehouse);
      const buildLines = () =>
        (lineItemsFiltered as ILineItem[]).map((item: ILineItem) => {
          const skuKey = String(item.sku || "")
            .trim()
            .toUpperCase();
          const d365Dims = d365LineDimensionsMap[skuKey];
          return {
            itemNumber: item.sku,
            quantity: item.quantity,
            trackingNumber: fulfilmentData.trackingNumber,
            shippingSiteId: d365Dims?.shippingSiteId || fulfilmentConfig.shippingSiteId,
            shippingWarehouseId:
              d365Dims?.shippingWarehouseId || fulfilmentConfig.shippingWarehouseId,
            shippingWarehouseLocationId:
              d365Dims?.shippingWarehouseLocationId ||
              fulfilmentConfig.shippingWarehouseLocationId,
            lotId: lotIdMap[skuKey] || "",
          };
        });

      let lines = buildLines();
      let missingLotIdSkus = lines
        .filter((line) => !String(line.lotId || "").trim())
        .map((line) => line.itemNumber);
      if (missingLotIdSkus.length > 0) {
        console.warn(
          `[GPS Individual][LotIdDebug] Missing lot IDs before fulfilment call: ${JSON.stringify({
            shopifyOrderName: fulfilmentData.shopifyOrderName || shopifyOrder.name,
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

      // Create fulfilment (packing slip + Standard invoice on deposit orders)
      const fulfilmentPost = await dynamics.createFulfilment({
        salesOrderNumber: d365Order.SalesOrderNumber,
        dataAreaId,
        type: "shipment",
        confirmedShippedDate: shippedDate,
        lines,
      });

      const depositPrecheck = await dynamics.verifyDepositFulfillmentApplied(
        d365Order.SalesOrderNumber,
        dataAreaId
      );
      const isDepositOrder = isDepositFulfillmentOrder({
        depositFulfillment: depositPrecheck.depositFulfillment,
        processingStatus: depositPrecheck.processingStatus,
      });
      if (isDepositOrder) {
        await dynamics.assertDepositShipmentInvoicingComplete(
          d365Order.SalesOrderNumber,
          dataAreaId,
          fulfilmentPost.response,
          { depositFulfillment: true }
        );
      }

      console.log(`[GPS Individual] Created D365 packing slip for: ${d365Order.SalesOrderNumber}`);
      return {
        skipped: false,
        salesOrderNumber: d365Order.SalesOrderNumber,
        dataAreaId,
        depositStandardInvoiceVerified: isDepositOrder,
      };
    });

    // Step 6: Send completion notification
    await step.run("send-completion-notification", async () => {
      const shopifyStatus = shopifyFulfillment.skipped ? "skipped" : "success";
      const d365Status = dynamicRecord.skipped ? "skipped" : "success";

      const message =
        `GPS Individual Fulfilment: ${fulfilmentData.shopifyOrderName} processed. ` +
        `\nTracking: ${fulfilmentData.trackingNumber} \nShopify: ${shopifyStatus} \nD365: ${d365Status}`;

      console.log(message);
      await slack.sendInfoMessage(SlackChannelEnum.GPS, message);
    });

    // Step 7: Notify Hub of fulfillment with GPS source
    await step.run("notify-hub-fulfillment", async () => {
      await csPlatform.sendOrderFulfilled({
        orderId: shopifyOrder.id?.toString(),
        shopifyOrderName: fulfilmentData.shopifyOrderName,
        trackingNumber: fulfilmentData.trackingNumber,
        carrier: fulfilmentData.carrier || "",
        fulfillmentSource: "gps",
        d365FulfillmentStatus: dynamicRecord.skipped ? "pending" : "synced",
        gpsFulfillmentStatus:
          dynamicRecord.skipped || shopifyFulfillment.skipped ? "processing" : "synced",
      });
    });

    logFlowEvent({
      flow: "gps_fulfillment",
      step: "done",
      status: "completed",
      runId: _runId,
      shopifyOrderName: fulfilmentData.shopifyOrderName,
      durationMs: Date.now() - _flowStart,
      payload: {
        gpsOrderNo: fulfilmentData.gpsOrderNo,
        trackingNumber: fulfilmentData.trackingNumber,
      },
    });
    return {
      status: "success",
      gpsOrderNo: fulfilmentData.gpsOrderNo,
      shopifyOrderName: fulfilmentData.shopifyOrderName,
      trackingNumber: fulfilmentData.trackingNumber,
      shopifyFulfillment,
      dynamicRecord,
    };
  }
);
