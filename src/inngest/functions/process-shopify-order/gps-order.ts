import * as gps from "@/lib/clients/gps";
import { OutOfStockError, isGpsInventoryError } from "@/lib/clients/gps";
import { setGpsOrderMetafield } from "@/lib/clients/shopify";
import * as slack from "@/lib/clients/slack";
import { config } from "@/lib/config";
import { shouldSendToGps, toGpsOutboundOrder } from "@/lib/transformers/order";
import { SlackChannelEnum } from "@/lib/types/slack";
import type { ShopifyOrderPayload } from "../../events";
import { splitShopifyFulfillmentOrder } from "./fulfillment-split";
import type { PublishStatus, StepTools } from "./types";

export async function processGpsOrder({
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  salesOrderNo,
  warehouseName,
  destinationCountryCode,
  saudiShortAddress,
  publishStatus,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  salesOrderNo: string;
  warehouseName: string;
  destinationCountryCode: string;
  saudiShortAddress?: string;
  publishStatus: PublishStatus;
}) {
  // --- Build GPS payload (pure transform, no external write) ---
  await publishStatus("gps.build-payload", "running", "Transforming order to GPS format");
  const shouldSendToRealGps =
    shouldSendToGps(order, warehouseName) && config.features.enableGpsSync;
  let gpsOrderPayload: ReturnType<typeof toGpsOutboundOrder> | null = null;
  try {
    gpsOrderPayload = toGpsOutboundOrder(order, salesOrderNo, warehouseName, saudiShortAddress);
    const itemCount = gpsOrderPayload?.productList?.length || 0;
    await publishStatus("gps.build-payload", "completed", `Payload built with ${itemCount} items`, {
      itemCount,
      warehouse: warehouseName,
    });
  } catch (error) {
    await slack.sendWarningMessage(
      "gps",
      `Failed to build GPS payload for ${shopifyOrderName}: ${error}`
    );
    await publishStatus("gps.build-payload", "skipped", "No GPS payload required");
  }

  const fulfillmentSplit = await splitShopifyFulfillmentOrder({
    step,
    order,
    shopifyOrderId,
    shopifyOrderName,
    destinationCountryCode,
    publishStatus,
  });

  // ── Step: send to GPS + store metafield ───────────────────────────
  let gpsResult:
    | { type: "real"; result: any; metafieldStored: boolean }
    | { type: "out_of_stock"; error: string }
    | { type: "failed"; error: string }
    | { type: "skipped"; reason: string };

  if (shouldSendToRealGps && gpsOrderPayload) {
    const payloadForStep = gpsOrderPayload;
    await publishStatus("gps.send-order", "running", `Sending order to ${warehouseName}`, {
      warehouse: warehouseName,
    });
    gpsResult = await step.run("gps-dispatch", async () => {
      try {
        const result = await gps.createOutboundOrder(
          payloadForStep,
          warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
        );

        const gpsOrderNo = result?.response?.data?.[0]?.orderNo;
        if (gpsOrderNo) {
          await setGpsOrderMetafield(shopifyOrderId, {
            gpsOrderId: gpsOrderNo,
            warehouse: warehouseName,
            d365OrderNumber: salesOrderNo,
            createdAt: new Date().toISOString(),
          });
          console.log(
            `[Shopify] Stored GPS metafield for order ${shopifyOrderName}: ${gpsOrderNo}`
          );
        }

        return { type: "real" as const, result, metafieldStored: !!gpsOrderNo };
      } catch (error) {
        if (error instanceof OutOfStockError) {
          console.log(`[GPS] ⚠️ Out of stock: ${error.message}`);
          return { type: "out_of_stock" as const, error: error.message };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isGpsInventoryError(errorMessage)) {
          console.log(`[GPS] ⚠️ Out of stock (message): ${errorMessage}`);
          return { type: "out_of_stock" as const, error: errorMessage };
        }

        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `⚠️ [GPS] Failed to create outbound order\n` +
            `Order: ${shopifyOrderName} (${salesOrderNo})\n` +
            `Warehouse: ${warehouseName}\n` +
            `Error: ${errorMessage}\n` +
            `D365 order created successfully, but GPS sync failed.`
        );

        return { type: "failed" as const, error: errorMessage };
      }
    });

    if (gpsResult.type === "failed") {
      await publishStatus(
        "gps.send-order",
        "failed",
        `GPS order creation failed: ${gpsResult.error}. Order will continue without GPS sync.`,
        {
          error: gpsResult.error,
          warehouse: warehouseName,
          salesOrderNumber: salesOrderNo,
        }
      );
    }
  } else {
    if (!shouldSendToRealGps) {
      await publishStatus(
        "gps.send-order",
        "skipped",
        `GPS sync not required - ${warehouseName} uses Shopify app`,
        { warehouse: warehouseName }
      );
    }
    gpsResult = {
      type: "skipped" as const,
      reason: !shouldSendToRealGps
        ? `GPS sync not required - ${warehouseName} uses Shopify app`
        : "GPS sync disabled or no payload",
    };
  }

  return { gpsResult, fulfillmentSplit };
}
