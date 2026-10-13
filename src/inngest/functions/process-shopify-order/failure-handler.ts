import * as csPlatform from "@/lib/clients/cs-platform";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import type { ShopifyOrderPayload } from "../../events";
import {
  inferInventoryErrorType,
  isD365ItemNotFoundError,
  isD365NumberSequenceExceededError,
  isInventoryIssueError,
  isNonRetryableOrderError,
} from "./error-classification";
import type { PublishResult, StepTools } from "./types";

export async function handleOrderProcessingFailure({
  error,
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  salesOrderNumber,
  warehouseName,
  inngestIdempotencyKey,
  inngestRunId,
  publishResult,
}: {
  error: unknown;
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  salesOrderNumber?: string;
  warehouseName: string;
  inngestIdempotencyKey: string;
  inngestRunId: string;
  publishResult: PublishResult;
}) {
  if (
    error instanceof NonRetriableError &&
    String(error.message || "").includes("[BACKORDER_TERMINAL]")
  ) {
    throw error;
  }

  const errorMsg = error instanceof Error ? error.message : String(error);
  const normalizedError = errorMsg.toLowerCase();
  const errorType = isD365NumberSequenceExceededError(normalizedError)
    ? "d365_number_sequence_exceeded"
    : normalizedError.includes("out of stock") || normalizedError.includes("inventory insufficient")
      ? "out_of_stock"
      : normalizedError.includes("order routing") ||
          (normalizedError.includes("location") && normalizedError.includes("not fully configured"))
        ? "routing_configuration"
        : normalizedError.includes("d365") || normalizedError.includes("dynamics")
          ? "d365_error"
          : normalizedError.includes("gps") || normalizedError.includes("xlwms")
            ? "gps_error"
            : "processing_error";

  // Route all inventory-related failures (GPS or D365 reservation issues) to backorder queue.
  if (isInventoryIssueError(errorMsg)) {
    const inventoryErrorType = inferInventoryErrorType(errorMsg);
    const failedSkus =
      order?.line_items?.map((p: { sku?: string }) => p.sku || "unknown").filter(Boolean) || [];

    await step.run("emit-backorder-event-on-catch", async () => {
      const failureSystem: "d365" | "gps" =
        normalizedError.includes("d365") || normalizedError.includes("dynamics") ? "d365" : "gps";
      await inngest.send({
        name: "backorder/created",
        data: {
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          warehouse: warehouseName || "GPS Warehouse",
          errorMessage: errorMsg,
          errorType: inventoryErrorType,
          failedSkus,
          retryCount: 0,
          // Out-of-stock/master-data issues should be parked, not loop-retried.
          maxRetries: 0,
          createdAt: new Date().toISOString(),
          sourceEventName: "shopify/order.paid",
          failureStage: "order_creation",
          failureSystem,
          retryMode: "gps_outbound",
          backorderQueue: "sync",
        },
      });
    });

    await step.run("notify-hub-backorder-on-catch", async () => {
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          shopifyOrderCreatedAt: order?.created_at,
          status: "backorder",
          processingStatus: "waiting_stock",
          gpsSyncStatus: "failed",
          error: errorMsg,
          lastError: errorMsg,
          errorType: inventoryErrorType,
          lastErrorType: inventoryErrorType,
          state: {
            failureContext: {
              stage: "order_creation",
              system:
                normalizedError.includes("d365") || normalizedError.includes("dynamics")
                  ? "d365"
                  : "gps",
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
      error: `Moved to backorder queue: ${errorMsg}`,
      d365OrderNumber: salesOrderNumber,
    });

    await slack.sendWarningMessage(
      "gpslow",
      `[Backorder] ${shopifyOrderName}: ${inventoryErrorType} - ${errorMsg}`
    );

    throw new NonRetriableError(
      `[BACKORDER_TERMINAL] ${shopifyOrderName} moved to backorder queue: ${inventoryErrorType}`
    );
  }

  // Service SKU "does not exist" errors are non-fatal config issues.
  // The step-level graceful skip should have caught these, but if not
  // (e.g. older deployment), don't mark the entire order as failed.
  const serviceSkuMatch = errorMsg.match(/create sales order line ((?:IM8|PRE)-SER-\d+)/i);
  if (serviceSkuMatch && isD365ItemNotFoundError(errorMsg)) {
    console.warn(
      `[D365] Service SKU ${serviceSkuMatch[1]} not registered in D365 — treating as warning, not failure. ` +
        `Order ${shopifyOrderName} will continue processing without this service line.`
    );

    await publishResult("success", {
      d365OrderNumber: salesOrderNumber,
    });

    await step.run("notify-hub-service-sku-warning", async () => {
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          shopifyOrderCreatedAt: order?.created_at,
          status: "completed",
          processingStatus: "completed",
          d365SyncStatus: "synced",
          d365OrderNumber: salesOrderNumber,
          lastError: `Service SKU ${serviceSkuMatch[1]} not registered in D365 (non-fatal)`,
          lastErrorType: "service_sku_missing",
        },
        { inngestIdempotencyKey, inngestRunId }
      );
    });

    return {
      status: "completed",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: salesOrderNumber,
      warning: `Service SKU ${serviceSkuMatch[1]} skipped`,
      processedAt: new Date().toISOString(),
    };
  }

  // Non-retryable configuration/master-data errors: record and stop here.
  // Do not rethrow, so Inngest function-level retries are avoided.
  if (isNonRetryableOrderError(errorMsg)) {
    const nonRetryableErrorType = isD365NumberSequenceExceededError(errorMsg)
      ? "d365_number_sequence_exceeded"
      : "non_retryable_data_error";
    const failedSkus =
      order?.line_items?.map((p: { sku?: string }) => p.sku || "unknown").filter(Boolean) || [];
    const syncFailureSystem =
      normalizedError.includes("gps") || normalizedError.includes("xlwms")
        ? "gps"
        : normalizedError.includes("supabase") ||
            normalizedError.includes("postgres") ||
            normalizedError.includes("database")
          ? "supabase"
          : "d365";

    await publishResult("failed", {
      error: errorMsg,
      d365OrderNumber: salesOrderNumber,
    });

    await step.run("emit-sync-backorder-event-non-retryable", async () => {
      await inngest.send({
        name: "backorder/created",
        data: {
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          warehouse: warehouseName || "GPS Warehouse",
          errorMessage: errorMsg,
          errorType: nonRetryableErrorType,
          failedSkus,
          retryCount: 0,
          maxRetries: 0,
          createdAt: new Date().toISOString(),
          sourceEventName: "shopify/order.paid",
          failureStage: "order_creation",
          failureSystem: syncFailureSystem,
          retryMode: "gps_outbound",
          backorderQueue: "sync",
        },
      });
    });

    await step.run("notify-hub-backorder-non-retryable", async () => {
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          shopifyOrderCreatedAt: order?.created_at,
          status: "backorder",
          processingStatus: "backorder",
          gpsSyncStatus: "failed",
          error: errorMsg,
          lastError: errorMsg,
          errorType: nonRetryableErrorType,
          lastErrorType: nonRetryableErrorType,
          state: {
            failureContext: {
              stage: "order_creation",
              system: syncFailureSystem,
              sourceEventName: "shopify/order.paid",
              retryMode: "gps_outbound",
              backorderQueue: "sync",
            },
          },
        },
        { inngestIdempotencyKey, inngestRunId }
      );
    });

    await slack.sendWarningMessage(
      SlackChannelEnum.SHOPIFY,
      `[Non-Retryable] ${shopifyOrderName}: ${errorMsg}`
    );

    return {
      status: "backorder",
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber: salesOrderNumber,
      error: errorMsg,
      errorType: nonRetryableErrorType,
      processedAt: new Date().toISOString(),
    };
  }

  // Publish failure result
  await publishResult("failed", { error: errorMsg });
  const failedSkus =
    order?.line_items?.map((p: { sku?: string }) => p.sku || "unknown").filter(Boolean) || [];
  const syncFailureSystem =
    normalizedError.includes("gps") || normalizedError.includes("xlwms")
      ? "gps"
      : normalizedError.includes("supabase") ||
          normalizedError.includes("postgres") ||
          normalizedError.includes("database")
        ? "supabase"
        : "d365";

  await step.run("emit-sync-backorder-event-catch-all", async () => {
    await inngest.send({
      name: "backorder/created",
      data: {
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNumber,
        warehouse: warehouseName || "GPS Warehouse",
        errorMessage: errorMsg,
        errorType,
        failedSkus,
        retryCount: 0,
        maxRetries: 0,
        createdAt: new Date().toISOString(),
        sourceEventName: "shopify/order.paid",
        failureStage: "order_creation",
        failureSystem: syncFailureSystem,
        retryMode: "gps_outbound",
        backorderQueue: "sync",
      },
    });
  });

  // Persist terminal failure back to Battle Hub via webhook so Orders/Testing
  // can report final run errors even when a run fails before a normal status update.
  await step.run("notify-hub-backorder-catch-all", async () => {
    await csPlatform.sendOrderUpdate(
      {
        id: shopifyOrderId,
        name: shopifyOrderName,
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNumber,
        shopifyOrderCreatedAt: order?.created_at,
        status: "backorder",
        processingStatus: "backorder",
        gpsSyncStatus: "failed",
        error: errorMsg,
        lastError: errorMsg,
        errorType,
        lastErrorType: errorType,
        state: {
          failureContext: {
            stage: "order_creation",
            system: syncFailureSystem,
            sourceEventName: "shopify/order.paid",
            retryMode: "gps_outbound",
            backorderQueue: "sync",
          },
        },
      },
      { inngestIdempotencyKey, inngestRunId }
    );
  });

  const channel = slack.determineErrorChannel(errorMsg);
  await slack.sendErrorMessage(
    channel,
    `Process Order parked in sync backorder queue: ${shopifyOrderName} - ${errorMsg}`
  );
  throw new NonRetriableError(
    `[BACKORDER_TERMINAL] ${shopifyOrderName} parked in sync queue due to order sync failure`
  );
}
