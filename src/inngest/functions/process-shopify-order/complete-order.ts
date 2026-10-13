import * as csPlatform from "@/lib/clients/cs-platform";
import { classifyGpsError, isGpsInventoryError } from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import { isGpsUkWarehouse } from "@/lib/helpers/warehouse";
import { flushAll as flushFlowLogs, logFlowEvent } from "@/lib/services/flow-logs";
import { SlackChannelEnum } from "@/lib/types/slack";
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import type { ShopifyOrderPayload } from "../../events";
import type { FulfillmentSplitResult } from "./fulfillment-split";
import type { OrderPaymentAccounting } from "./payment-accounting";
import type { OrderSyncResult, PublishResult, PublishStatus, StepTools } from "./types";

export async function completeOrderProcessing({
  syncResult,
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  salesOrderNumber,
  warehouseName,
  gpsLogisticsChannel,
  fulfillmentSplit,
  paymentAccounting,
  inngestIdempotencyKey,
  inngestRunId,
  orderProcessingStart,
  stepDurations,
  publishStatus,
  publishResult,
  handOffSequencedRunIfAny,
}: {
  syncResult: OrderSyncResult;
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  salesOrderNumber: string;
  warehouseName: string;
  gpsLogisticsChannel?: string;
  fulfillmentSplit: FulfillmentSplitResult;
  paymentAccounting: OrderPaymentAccounting;
  inngestIdempotencyKey: string;
  inngestRunId: string;
  orderProcessingStart: number;
  stepDurations: Array<{ step: string; durationMs: number }>;
  publishStatus: PublishStatus;
  publishResult: PublishResult;
  handOffSequencedRunIfAny: (payload: Record<string, unknown>) => Promise<void>;
}) {
  // Extract results from the mega-step
  const salesOrderNo = salesOrderNumber;
  const d365InventoryLotsBySku = syncResult.d365InventoryLotsBySku || {};
  const gpsResult = syncResult.gpsResult;

  // Publish GPS result
  if (gpsResult.type === "real" && "result" in gpsResult) {
    const gpsOrderNo = gpsResult.result?.response?.data?.[0]?.orderNo;
    await publishStatus("gps.send-order", "completed", `GPS order created: ${gpsOrderNo || "OK"}`, {
      gpsOrderNo,
      warehouse: warehouseName,
    });
    if (gpsOrderNo) {
      await publishStatus("gps.store-metafield", "completed", `Metafield stored: ${gpsOrderNo}`, {
        gpsOrderNo,
      });
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNo,
          warehouse: warehouseName,
          gpsOrderId: gpsOrderNo,
          gpsSyncStatus: "synced",
          shopifyOrderCreatedAt: order?.created_at,
        },
        { inngestIdempotencyKey, inngestRunId }
      );
    }
  } else if (gpsResult.type === "failed" && !isGpsInventoryError(gpsResult.error)) {
    console.log(`[GPS] Order processing will continue despite GPS failure`);
  } else if (gpsResult.type === "skipped") {
    await publishStatus("gps.send-order", "skipped", "GPS sync not required for this order");
  }

  // Handle inventory errors — emit to backorder queue for durable retry
  let routedToBackorder = false;
  if (
    gpsResult.type === "out_of_stock" ||
    (gpsResult.type === "failed" && isGpsInventoryError(gpsResult.error))
  ) {
    const oosError =
      gpsResult.type === "out_of_stock"
        ? "error" in gpsResult
          ? gpsResult.error
          : "Unknown"
        : gpsResult.error;
    const errorType = classifyGpsError(oosError);
    const failedSkus =
      order?.line_items?.map((p: { sku?: string }) => p.sku || "unknown").filter(Boolean) || [];

    await publishStatus(
      "gps.send-order",
      "failed",
      `Inventory error: ${oosError}. Sending to backorder queue.`,
      { errorType, error: oosError }
    );

    await slack.sendWarningMessage(
      "gpslow",
      `[Backorder] ${shopifyOrderName}: ${errorType} - ${oosError}\nSKUs: ${failedSkus.join(", ")}`
    );

    await step.run("emit-backorder-event", async () => {
      await inngest.send({
        name: "backorder/created",
        data: {
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          warehouse: warehouseName,
          errorMessage: oosError,
          errorType,
          failedSkus,
          retryCount: 0,
          maxRetries: 0,
          createdAt: new Date().toISOString(),
          sourceEventName: "shopify/order.paid",
          failureStage: "order_creation",
          failureSystem: "gps",
          retryMode: "gps_outbound",
          backorderQueue: "sync",
        },
      });
    });
    routedToBackorder = true;

    await step.run("notify-hub-backorder-oos", async () => {
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNo,
          warehouse: warehouseName,
          shopifyOrderCreatedAt: order?.created_at,
          status: "backorder",
          processingStatus: "waiting_stock",
          gpsSyncStatus: "failed",
          error: oosError,
          lastError: oosError,
          errorType,
          lastErrorType: errorType,
          state: {
            failureContext: {
              stage: "order_creation",
              system: "gps",
              sourceEventName: "shopify/order.paid",
              retryMode: "gps_outbound",
              backorderQueue: "sync",
            },
          },
        },
        { inngestIdempotencyKey, inngestRunId }
      );
    });
  }

  await publishStatus("send-to-gps", "completed", "GPS warehouse order processed", {
    gpsResult,
  });

  if (!routedToBackorder) {
    try {
      await slack.sendOrderMessage(
        SlackChannelEnum.SHOPIFY,
        `Order ${shopifyOrderName} processed successfully. D365: ${salesOrderNo}`
      );
    } catch (slackErr) {
      console.warn(
        `[Slack] Success notify failed (non-fatal) for ${shopifyOrderName}:`,
        slackErr instanceof Error ? slackErr.message : slackErr
      );
    }
  }

  const result = {
    status: routedToBackorder ? "backorder" : "success",
    shopifyOrderId,
    shopifyOrderName,
    d365OrderNumber: salesOrderNo,
    warehouse: warehouseName,
    gpsResult,
    processedAt: new Date().toISOString(),
  };

  // Extract GPS order ID for use in final events
  let gpsOrderId: string | undefined;
  const gpsSkipped = gpsResult?.type === "skipped";

  if (gpsResult?.type === "real" && "result" in gpsResult) {
    const gpsData = gpsResult.result?.response?.data;
    if (Array.isArray(gpsData) && gpsData.length > 0) {
      gpsOrderId = (gpsData[0] as any)?.outboundOrderNo || (gpsData[0] as any)?.orderNo;
    }
  }

  if (routedToBackorder) {
    await publishResult("failed", {
      d365OrderNumber: salesOrderNo,
      warehouse: warehouseName,
      error: "Order moved to backorder queue due to inventory issue",
    });
  } else {
    await publishResult("success", {
      d365OrderNumber: salesOrderNo,
      gpsOrderNo: gpsOrderId,
      warehouse: warehouseName,
    });
  }

  if (!routedToBackorder) {
    await step.run("notify-hub-order-created-and-synced", async () => {
      await Promise.all([
        csPlatform.sendOrderCreated(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNo,
            warehouse: warehouseName,
            gpsOrderId,
            gpsUkOrderId: isGpsUkWarehouse(warehouseName) && gpsOrderId ? gpsOrderId : undefined,
            gpsSkipped,
            orderJson: order,
            state: {
              ...(Object.keys(d365InventoryLotsBySku).length > 0 ? { d365InventoryLotsBySku } : {}),
              fulfillmentSplit,
              ...(gpsLogisticsChannel ? { gpsLogisticsChannel } : {}),
              paymentAccounting: {
                paymentReference: paymentAccounting.paymentReference,
                giftCardApplications: paymentAccounting.giftCardApplications,
                giftCardPurchases: paymentAccounting.giftCardPurchases,
              },
            },
          },
          { inngestIdempotencyKey, inngestRunId }
        ),
        csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNo,
            warehouse: warehouseName,
            gpsOrderId,
            gpsUkOrderId: isGpsUkWarehouse(warehouseName) && gpsOrderId ? gpsOrderId : undefined,
            shopifyOrderCreatedAt: order?.created_at,
            status: "completed",
            processingStatus: "completed",
            d365SyncStatus: "synced",
            gpsSyncStatus:
              gpsResult?.type === "real" ? "synced" : gpsSkipped ? "skipped" : "pending",
            lastError: null,
            lastErrorType: null,
            retryAt: null,
            state: {
              ...(Object.keys(d365InventoryLotsBySku).length > 0 ? { d365InventoryLotsBySku } : {}),
              fulfillmentSplit,
              ...(gpsLogisticsChannel ? { gpsLogisticsChannel } : {}),
              paymentAccounting: {
                paymentReference: paymentAccounting.paymentReference,
                giftCardApplications: paymentAccounting.giftCardApplications,
                giftCardPurchases: paymentAccounting.giftCardPurchases,
              },
              failureContext: null,
            },
          },
          { inngestIdempotencyKey, inngestRunId }
        ),
      ]);
    });
  }

  if (routedToBackorder) {
    throw new NonRetriableError(
      `[BACKORDER_TERMINAL] ${shopifyOrderName} moved to backorder queue due to inventory issue`
    );
  }

  // Emit processing time summary
  const totalProcessingMs = Date.now() - orderProcessingStart;
  const sortedSteps = [...stepDurations].sort((a, b) => b.durationMs - a.durationMs);
  logFlowEvent({
    level: "info",
    flow: "order_paid",
    step: "processing_summary",
    runId: inngestRunId,
    shopifyOrderId,
    shopifyOrderName,
    d365OrderNumber: salesOrderNo,
    status: "completed",
    durationMs: totalProcessingMs,
    payload: {
      totalProcessingMs,
      stepCount: sortedSteps.length,
      slowestSteps: sortedSteps.slice(0, 5).map((s) => ({
        step: s.step,
        durationMs: s.durationMs,
        pct: Math.round((s.durationMs / totalProcessingMs) * 100),
      })),
      allSteps: sortedSteps,
    },
  });
  await flushFlowLogs();

  await handOffSequencedRunIfAny({
    status: "completed",
    d365OrderNumber: salesOrderNumber,
  });

  return result;
}
