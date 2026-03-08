import { inngest } from "../client";
import { config } from "@/lib/config";
import {
  IGpsIndividualFulfilment,
  IGpsGetOrderData,
  IGpsIndividualOrderData,
} from "@/lib/types/gps";
import { SlackChannelEnum } from "@/lib/types/slack";
import { THROTTLE_CONFIGS, CONCURRENCY_CONFIGS, RETRY_CONFIGS } from "@/lib/utils/constants";

import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";

const processGpsBatchConfig = Object.freeze({
  id: "process-gps-batch",
  name: "Process GPS Batch",
  retries: RETRY_CONFIGS.DEFAULT,
  throttle: THROTTLE_CONFIGS.GPS,
  concurrency: CONCURRENCY_CONFIGS.STANDARD,
});

/**
 * Process GPS orders in batch to individual events
 */
export const processGpsBatch = inngest.createFunction(
  processGpsBatchConfig,
  { event: "gps/batch.process" },
  async ({ event, step }: { event: any; step: any }) => {
    const { gpsOrderIds, warehouse, batchId } = event.data;
    console.log(`[GPS Batch] Starting batch ${batchId} with ${gpsOrderIds.length} orders`);

    // Step 1: Fetch GPS order details in batches
    const fulfilledOrders = await step.run("fetch-gps-order-details", async () => {
      const allFulfilledOrders: IGpsGetOrderData[] = [];
      const totalBatches = Math.ceil(gpsOrderIds.length / config.gps.batchSize);

      for (let i = 0; i < gpsOrderIds.length; i += config.gps.batchSize) {
        const batchNumber = Math.floor(i / config.gps.batchSize) + 1;
        const chunk = gpsOrderIds.slice(i, i + config.gps.batchSize);
        console.log(
          `[GPS Batch] Fetching batch ${batchNumber}/${totalBatches} with ${chunk.length} orders`
        );

        const gpsOrdersResponse = await gps.getOutboundOrdersDetails(chunk, warehouse);
        const gpsOrders = Array.isArray(gpsOrdersResponse.response.data)
          ? gpsOrdersResponse.response.data
          : [];

        if (gpsOrders.length === 0) {
          console.error(`[GPS Batch] Unexpected response for batch ${batchNumber}`);
          await slack.sendErrorMessage(
            SlackChannelEnum.GPS,
            `[GPS Batch] Unexpected response from GPS for batch ${batchNumber}`
          );
          continue;
        }

        const fulfilled = gpsOrders.filter(
          (order) => order.status === config.gps.gpsFulfilledStatus
        );
        if (fulfilled.length > 0) {
          allFulfilledOrders.push(...fulfilled);
          console.log(
            `[GPS Batch] Batch ${batchNumber}: Found ${fulfilled.length} fulfilled orders`
          );
        }
      }
      console.log(`[GPS Batch] Total fulfilled orders found: ${allFulfilledOrders.length}`);

      // Notify if no fulfilled orders found
      if (allFulfilledOrders.length === 0) {
        console.log("[GPS Batch] No GPS orders ready for fulfillment");
        await slack.sendInfoMessage(
          SlackChannelEnum.GPS,
          `[GPS Batch] Batch ${batchId}: No fulfilled orders found out of ${gpsOrderIds.length} orders`
        );
      }
      return allFulfilledOrders;
    });

    if (fulfilledOrders.length === 0) {
      return {
        batchId,
        status: "completed",
        totalOrders: gpsOrderIds.length,
        fulfilledOrdersFound: 0,
        eventsTriggered: 0,
      };
    }

    // Step 2: Validate and filter orders
    const validOrders = await step.run("validate-orders", async (): Promise<IGpsGetOrderData[]> => {
      return fulfilledOrders.filter((orderData: IGpsGetOrderData) => {
        if (!orderData.outboundOrderNo || !orderData.logisticsTrackNo || !orderData.outboundTime) {
          console.error(
            `[GPS Batch] Order ${orderData.outboundOrderNo || "unknown"} missing required fields`
          );
          return false;
        }
        return true;
      });
    });

    if (validOrders.length === 0) {
      return {
        batchId,
        status: "completed",
        totalOrders: gpsOrderIds.length,
        fulfilledOrdersFound: fulfilledOrders.length,
        validOrders: 0,
        eventsTriggered: 0,
      };
    }

    // Step 3: Trigger individual fulfilment events
    const eventResults = await step.run("trigger-individual-events", async () => {
      const events = validOrders.map((orderData: IGpsGetOrderData) => {
        const eventId = `GPSI${orderData.outboundOrderNo}`;
        const fulfilmentPayload: IGpsIndividualFulfilment = {
          type: "individual",
          warehouse,
          orderData: orderData as IGpsIndividualOrderData,
        };

        return {
          id: eventId,
          name: "gps/individual.fulfilment" as const,
          data: {
            gpsOrderNo: orderData.outboundOrderNo,
            shopifyOrderName: orderData.platformOrderNo,
            trackingNumber: orderData.logisticsTrackNo,
            warehouse,
            fulfilmentPayload,
            receivedAt: new Date().toISOString(),
          },
        };
      });

      // Send all events in one batch call
      const result = await inngest.send(events);
      console.log(`[GPS Batch] Triggered ${result.ids?.length || 0} individual events`);
      return result.ids || [];
    });

    // Step 4: Send completion notification
    await step.run("send-completion-notification", async () => {
      const message =
        `[GPS Batch] Batch ${batchId} completed: ${eventResults.length} fulfilment events triggered for ` +
        `${validOrders.length} fulfilled orders`;
      console.log(message);
      await slack.sendInfoMessage(SlackChannelEnum.GPS, message);
    });

    return {
      batchId,
      status: "completed",
      totalOrders: gpsOrderIds.length,
      fulfilledOrdersFound: fulfilledOrders.length,
      validOrders: validOrders.length,
      eventsTriggered: eventResults.length,
      eventIds: eventResults,
    };
  }
);
