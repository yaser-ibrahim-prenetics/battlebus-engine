import { inngest } from "../../client";
import type { ShopifyOrderPayload } from "../../events";
import * as gps from "@/lib/clients/gps";
import { getOrder, getOrderMetafields, setGpsOrderMetafield } from "@/lib/clients/shopify";
import { getIm8ShortAddressFromMetafields } from "@/lib/transformers/address";
import { toGpsOutboundOrder } from "@/lib/transformers/order";

export type BackorderRetryMode = "gps_outbound" | "fulfillment_replay";

export interface BackorderRetryResult {
  success: boolean;
  gpsOrderNo?: string;
  replayDispatched?: boolean;
  error?: string;
  isInventoryError?: boolean;
}

export async function retryBackorder(params: {
  shopifyOrderId: string | number;
  shopifyOrderName: string;
  shopifyStore?: string;
  d365OrderNumber?: string;
  warehouse: string;
  retryMode: BackorderRetryMode;
}): Promise<BackorderRetryResult> {
  try {
    const freshOrder = await getOrder(params.shopifyOrderId, params.shopifyStore);
    const order = freshOrder as unknown as ShopifyOrderPayload;
    const d365OrderNumber = String(params.d365OrderNumber || "").trim();

    if (params.retryMode === "gps_outbound" && !d365OrderNumber) {
      await inngest.send({
        name: "shopify/order.paid",
        data: {
          shopifyOrderId: String(params.shopifyOrderId),
          shopifyOrderName: params.shopifyOrderName,
          shopifyStore: params.shopifyStore || "im8-battle-bus",
          orderJson: order,
          receivedAt: new Date().toISOString(),
        },
      });
      return { success: true, replayDispatched: true };
    }

    if (params.retryMode === "fulfillment_replay") {
      const fulfillments = Array.isArray((order as any)?.fulfillments)
        ? ((order as any).fulfillments as any[])
        : [];
      if (fulfillments.length === 0) {
        return {
          success: false,
          error: "No Shopify fulfillments found to replay",
          isInventoryError: false,
        };
      }

      await inngest.send({
        name: "shopify/order.fulfilled",
        data: {
          shopifyOrderId: params.shopifyOrderId,
          shopifyOrderName: params.shopifyOrderName,
          shopifyStore: params.shopifyStore || "im8-battle-bus",
          orderJson: order,
          fulfillments,
          receivedAt: new Date().toISOString(),
          fromBackorderRetry: true,
        },
      });
      return { success: true, replayDispatched: true };
    }

    const shortAddress =
      order.shipping_address?.country_code === "SA"
        ? getIm8ShortAddressFromMetafields(
            await getOrderMetafields(params.shopifyOrderId, params.shopifyStore)
          )
        : "";
    const gpsPayload = toGpsOutboundOrder(order, d365OrderNumber, params.warehouse, shortAddress);
    const result = await gps.createOutboundOrder(
      gpsPayload,
      params.warehouse as "GPS Warehouse" | "GPS UK Warehouse"
    );
    const gpsOrderNo = result?.response?.data?.[0]?.orderNo;
    if (gpsOrderNo) {
      await setGpsOrderMetafield(params.shopifyOrderId, {
        gpsOrderId: gpsOrderNo,
        warehouse: params.warehouse,
        d365OrderNumber,
        createdAt: new Date().toISOString(),
      });
    }
    return { success: true, gpsOrderNo };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      isInventoryError:
        params.retryMode === "fulfillment_replay" ? false : gps.isGpsInventoryError(message),
    };
  }
}
