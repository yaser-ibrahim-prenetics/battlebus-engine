import * as csPlatform from "@/lib/clients/cs-platform";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import { OutOfStockError, classifyGpsError, isGpsInventoryError } from "@/lib/clients/gps";
import { setGpsOrderMetafield } from "@/lib/clients/shopify";
import * as slack from "@/lib/clients/slack";
import { config } from "@/lib/config";
import {
  calculateOrderCost,
  shouldSendToGps,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
} from "@/lib/transformers/order";
import { retryWithBackoff } from "@/lib/utils/constants";
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import type { ShopifyOrderPayload } from "../../events";
import type { OrderSyncResult, PublishResult, PublishStatus, StepTools } from "./types";

export async function handleExistingD365Order({
  syncResult,
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  warehouseName,
  saudiShortAddress,
  dataAreaId,
  skipD365,
  inngestIdempotencyKey,
  inngestRunId,
  publishStatus,
  publishResult,
  handOffSequencedRunIfAny,
}: {
  syncResult: OrderSyncResult;
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  warehouseName: string;
  saudiShortAddress?: string;
  dataAreaId: string;
  skipD365: boolean;
  inngestIdempotencyKey: string;
  inngestRunId: string;
  publishStatus: PublishStatus;
  publishResult: PublishResult;
  handOffSequencedRunIfAny: (payload: Record<string, unknown>) => Promise<void>;
}) {
  // Handle existing order early return
  if (syncResult.type === "already_exists") {
    const reusedSalesOrderNumber = syncResult.salesOrderNumber;
    await publishStatus(
      "create-d365-order",
      "completed",
      `Existing D365 order reused: ${reusedSalesOrderNumber}`,
      { d365OrderNumber: reusedSalesOrderNumber, reused: true }
    );

    // Existing D365 order may have been created earlier without a posted
    // prepayment (e.g. partial prior run). Re-attempt prepayment here.
    const reusedLines = toD365SalesOrderLines(
      order,
      reusedSalesOrderNumber,
      warehouseName,
      true,
      dataAreaId
    );
    const reusedPrepaymentAmount = calculateOrderCost(
      reusedLines.map((line) => ({
        price: line.price,
        discount: line.discount,
        quantity: line.quantity,
      }))
    );
    if (!skipD365 && reusedPrepaymentAmount > 0) {
      await publishStatus(
        "d365.create-prepayment",
        "running",
        `Re-attempting prepayment for existing order: $${reusedPrepaymentAmount.toFixed(2)}`,
        {
          amount: reusedPrepaymentAmount,
          salesOrderNumber: reusedSalesOrderNumber,
          reusedOrder: true,
        }
      );
      try {
        await retryWithBackoff(
          () => dynamics.createPrepayment(reusedSalesOrderNumber, dataAreaId),
          {
            label: `d365-create-prepayment-existing-${shopifyOrderName}-${reusedSalesOrderNumber}`,
            maxAttempts: 3,
          }
        );
        const reusedDepositCheck = await dynamics.verifyDepositFulfillmentApplied(
          reusedSalesOrderNumber,
          dataAreaId
        );
        await publishStatus(
          "d365.create-prepayment",
          "completed",
          reusedDepositCheck.ok
            ? `Prepayment ensured for existing order: $${reusedPrepaymentAmount.toFixed(2)} (DepositFulfillment=Yes)`
            : `Prepayment posted but THK_DepositFulfillment=${reusedDepositCheck.depositFulfillment ?? "<empty>"} ` +
                `— invoice will post as Standard, not Prepayment. ` +
                `Fix the customer/posting profile in D365 for the ordering account.`,
          {
            amount: reusedPrepaymentAmount,
            salesOrderNumber: reusedSalesOrderNumber,
            reusedOrder: true,
            depositFulfillment: reusedDepositCheck.depositFulfillment,
            processingStatus: reusedDepositCheck.processingStatus,
            expectedInvoiceType: reusedDepositCheck.ok ? "Prepayment" : "Standard",
            dataAreaId,
          }
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await publishStatus(
          "d365.create-prepayment",
          "failed",
          `Prepayment failed for existing order: ${errorMessage}`,
          {
            amount: reusedPrepaymentAmount,
            salesOrderNumber: reusedSalesOrderNumber,
            reusedOrder: true,
            error: errorMessage,
          }
        );
        throw new Error(
          `[D365] Prepayment creation failed for existing order ${shopifyOrderName} (${reusedSalesOrderNumber}): ${errorMessage}`
        );
      }
    }

    type ExistingOrderGpsRetryResult =
      | { type: "real"; gpsOrderNo?: string }
      | { type: "skipped"; reason: string }
      | { type: "failed"; error: string }
      | { type: "out_of_stock"; error: string };

    const gpsRetryResult = await step.run("retry-gps-for-existing-d365-order", async () => {
      const shouldSendToRealGps =
        shouldSendToGps(order, warehouseName) && config.features.enableGpsSync;
      if (!shouldSendToRealGps) {
        return {
          type: "skipped" as const,
          reason: `GPS sync not required - ${warehouseName} uses Shopify app`,
        } satisfies ExistingOrderGpsRetryResult;
      }

      try {
        const gpsOrderPayload = toGpsOutboundOrder(
          order,
          reusedSalesOrderNumber,
          warehouseName,
          saudiShortAddress
        );
        const result = await gps.createOutboundOrder(
          gpsOrderPayload,
          warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
        );
        const gpsOrderNo = result?.response?.data?.[0]?.orderNo;

        if (gpsOrderNo) {
          await setGpsOrderMetafield(shopifyOrderId, {
            gpsOrderId: gpsOrderNo,
            warehouse: warehouseName,
            d365OrderNumber: reusedSalesOrderNumber,
            createdAt: new Date().toISOString(),
          });
        }

        return {
          type: "real" as const,
          gpsOrderNo,
        } satisfies ExistingOrderGpsRetryResult;
      } catch (error) {
        if (error instanceof OutOfStockError) {
          return {
            type: "out_of_stock" as const,
            error: error.message,
          } satisfies ExistingOrderGpsRetryResult;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          type: "failed" as const,
          error: errorMessage,
        } satisfies ExistingOrderGpsRetryResult;
      }
    });

    if (gpsRetryResult.type === "real") {
      await publishStatus(
        "gps.send-order",
        "completed",
        `GPS order created: ${gpsRetryResult.gpsOrderNo || "OK"}`,
        { gpsOrderNo: gpsRetryResult.gpsOrderNo, warehouse: warehouseName }
      );
    } else if (gpsRetryResult.type === "skipped") {
      await publishStatus("gps.send-order", "skipped", gpsRetryResult.reason, {
        warehouse: warehouseName,
      });
    } else if (
      gpsRetryResult.type === "out_of_stock" ||
      (gpsRetryResult.type === "failed" && isGpsInventoryError(gpsRetryResult.error))
    ) {
      const oosError = gpsRetryResult.error;

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

      await step.run("emit-backorder-event-existing-d365-oos", async () => {
        await inngest.send({
          name: "backorder/created",
          data: {
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: reusedSalesOrderNumber,
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

      await step.run("notify-hub-backorder-existing-d365-oos", async () => {
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: reusedSalesOrderNumber,
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

      await publishResult("failed", {
        error: oosError,
        d365OrderNumber: reusedSalesOrderNumber,
        warehouse: warehouseName,
      });

      throw new NonRetriableError(
        `[BACKORDER_TERMINAL] ${shopifyOrderName} moved to backorder queue due to inventory issue`
      );
    } else {
      await publishStatus(
        "gps.send-order",
        "failed",
        `GPS retry failed for reused D365 order: ${gpsRetryResult.error}`,
        {
          warehouse: warehouseName,
          error: gpsRetryResult.error,
          d365OrderNumber: reusedSalesOrderNumber,
        }
      );
    }

    const gpsSyncStatusFromRetry: "synced" | "skipped" | "failed" =
      gpsRetryResult.type === "real"
        ? "synced"
        : gpsRetryResult.type === "skipped"
          ? "skipped"
          : "failed";

    await publishResult("success", {
      d365OrderNumber: reusedSalesOrderNumber,
      gpsOrderNo: gpsRetryResult.type === "real" ? gpsRetryResult.gpsOrderNo : undefined,
      warehouse: warehouseName,
    });

    await step.run("notify-hub-already-exists-synced", async () => {
      await Promise.all([
        csPlatform.sendOrderCreated(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: reusedSalesOrderNumber,
            warehouse: warehouseName,
            gpsOrderId: gpsRetryResult.type === "real" ? gpsRetryResult.gpsOrderNo : undefined,
            gpsSkipped: gpsRetryResult.type === "skipped",
            orderJson: order,
          },
          { inngestIdempotencyKey, inngestRunId }
        ),
        csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: reusedSalesOrderNumber,
            warehouse: warehouseName,
            gpsOrderId: gpsRetryResult.type === "real" ? gpsRetryResult.gpsOrderNo : undefined,
            shopifyOrderCreatedAt: order?.created_at,
            status: "completed",
            processingStatus: "completed",
            d365SyncStatus: "synced",
            gpsSyncStatus: gpsSyncStatusFromRetry,
            lastError: gpsRetryResult.type === "failed" ? gpsRetryResult.error : null,
            lastErrorType: gpsRetryResult.type === "failed" ? "gps_error" : null,
            retryAt: null,
            state: { failureContext: null },
          },
          { inngestIdempotencyKey, inngestRunId }
        ),
      ]);
    });

    await handOffSequencedRunIfAny({
      status: "already_exists",
      d365OrderNumber: reusedSalesOrderNumber,
    });

    return {
      status: "already_exists",
      d365OrderNumber: reusedSalesOrderNumber,
      gpsSyncStatus: gpsSyncStatusFromRetry,
      gpsOrderNo: gpsRetryResult.type === "real" ? gpsRetryResult.gpsOrderNo : undefined,
      shopifyOrderId,
    };
  }
  return null;
}
