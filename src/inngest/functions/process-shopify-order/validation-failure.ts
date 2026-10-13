import * as csPlatform from "@/lib/clients/cs-platform";
import * as slack from "@/lib/clients/slack";
import { determineWarehouse } from "@/lib/helpers/warehouse";
import { SlackChannelEnum } from "@/lib/types/slack";
import { inngest } from "../../client";
import { CancelReasonEnum, type ShopifyOrderPayload } from "../../events";
import type { PrepareOrderResult } from "./prepare-order";
import type { PublishResult, PublishStatus, StepTools } from "./types";

export async function handleValidationFailure({
  prepareResult,
  step,
  eventName,
  shopifyOrderId,
  shopifyOrderName,
  shopifyStore,
  inngestIdempotencyKey,
  inngestRunId,
  publishStatus,
  publishResult,
}: {
  prepareResult: PrepareOrderResult;
  step: StepTools;
  eventName: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyStore: string;
  inngestIdempotencyKey: string;
  inngestRunId: string;
  publishStatus: PublishStatus;
  publishResult: PublishResult;
}) {
  // Handle validation failures (returned from within the consolidated step)
  if (prepareResult.type === "validation_failed") {
    const validation = prepareResult.validation;
    const parkedOrder = prepareResult.updatedOrder as ShopifyOrderPayload;

    // Park on Hub sync backorders (operator visibility + manual replay) for all
    // validation blocks except cancelled Shopify orders and configured test-order skips.
    if (
      validation.status !== "cancelled" &&
      !(validation.status === "skipped" && validation.reason === "Test order")
    ) {
      const countryCode =
        parkedOrder.shipping_address?.country_code ||
        parkedOrder.billing_address?.country_code ||
        "US";
      const warehouseName = determineWarehouse(countryCode);
      const failedSkus = Array.isArray(parkedOrder.line_items)
        ? parkedOrder.line_items
            .map((li: { sku?: string }) => String(li.sku || "").trim())
            .filter(Boolean)
        : [];
      const validationMessage =
        [validation.reason, ...(Array.isArray(validation.message) ? validation.message : [])]
          .filter(Boolean)
          .join("; ") || "Order validation failed";

      await step.run("emit-order-validation-backorder", async () => {
        await inngest.send({
          name: "backorder/created",
          data: {
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: "",
            warehouse: warehouseName,
            errorMessage: validationMessage,
            errorType: "order_validation",
            failedSkus,
            retryCount: 0,
            maxRetries: 0,
            createdAt: new Date().toISOString(),
            sourceEventName: eventName,
            failureStage: "order_creation",
            failureSystem: "validation",
            retryMode: "gps_outbound",
            backorderQueue: "sync",
            shopifyStore,
          },
        });
      });

      await step.run("notify-hub-order-validation-backorder", async () => {
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            warehouse: warehouseName,
            shopifyOrderCreatedAt: parkedOrder?.created_at,
            status: "backorder",
            processingStatus: "waiting_stock",
            error: validationMessage,
            lastError: validationMessage,
            errorType: "order_validation",
            lastErrorType: "order_validation",
            state: {
              failureContext: {
                stage: "order_creation",
                system: "validation",
                sourceEventName: eventName,
                retryMode: "gps_outbound",
                backorderQueue: "sync",
              },
            },
          },
          { inngestIdempotencyKey, inngestRunId }
        );
      });
    }

    await publishStatus("validate-order", "skipped", validation.reason);
    await publishResult("skipped", { error: validation.reason });

    if (validation.status === "failed_validation") {
      await slack.sendErrorMessage(
        SlackChannelEnum.SHOPIFY,
        `Order ${shopifyOrderName} validation failed: ${validation.reason}`
      );
    } else if (validation.status === "skipped" && validation.reason === "High-risk order") {
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `Skipping High Risk Order: ${shopifyOrderName}`
      );
    } else if (validation.status === "fraud_hold") {
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `[Battle Bus] Skip high risk order for ${shopifyOrderId}`
      );
    } else if (validation.status === "cancelled") {
      const cancelReason =
        CancelReasonEnum[validation.cancelReason as keyof typeof CancelReasonEnum] ||
        validation.cancelReason;
      console.log(`[Battle Bus] Order was cancelled due to ${cancelReason}`);
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `[Battle Bus] Order was cancelled due to ${cancelReason}`
      );
    } else if (validation.status === "risk_order") {
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `[Battle Bus] Order contain risk: ${validation.message?.join(", ")}`
      );
    }

    return {
      status: validation.status,
      reason: validation.reason,
      shopifyOrderId,
      orderName: shopifyOrderName,
      ...(validation.message && { message: validation.message }),
      ...(validation.skus && { skus: validation.skus }),
      ...(validation.cancelReason && { cancelReason: validation.cancelReason }),
    };
  }
  return null;
}
