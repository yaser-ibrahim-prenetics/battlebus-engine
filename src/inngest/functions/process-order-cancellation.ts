import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as shopify from "@/lib/clients/shopify";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "@/lib/utils/constants";
import { ShopifyOrderPayload } from "../events";
import { SlackChannelEnum } from "@/lib/types/slack";

export const processOrderCancellation = inngest.createFunction(
  {
    id: "process-order-cancellation",
    name: "Process Order Cancellation",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    throttle: {
      ...THROTTLE_CONFIGS.CANCELLATION,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.CANCELLATION,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.CANCELLATION,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/order.cancelled" },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, cancelReason, orderJson } = event.data;
    const shopifyOrderPayload = orderJson as ShopifyOrderPayload;
    const isGpsWarehouse = (name?: string | null): name is "GPS Warehouse" | "GPS UK Warehouse" =>
      name === "GPS Warehouse" || name === "GPS UK Warehouse";

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
      };
    }

    // 1. Get D365 Order (lookup by order name, not ID, since THK_ShopifyReference stores the order name)
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., #D365-GPS-123)
      return dynamics.getSalesOrderByShopifyId(shopifyOrderName);
    });

    // 2. Try to Cancel GPS Order (only when we have GPS metafield data)
    const gpsCancellation = await step.run("cancel-gps-order", async () => {
      if (!config.features.enableGpsSync) {
        return { status: "skipped", reason: "GPS sync disabled" };
      }

      try {
        const gpsMeta = await shopify.getGpsOrderMetafield(shopifyOrderId);
        if (gpsMeta?.gpsOrderId) {
          if (!isGpsWarehouse(gpsMeta.warehouse)) {
            return {
              status: "skipped",
              reason: `Non-GPS warehouse (${gpsMeta.warehouse || "unknown"})`,
            };
          }

          const result = await gps.cancelOutboundOrder(gpsMeta.gpsOrderId, gpsMeta.warehouse);
          return { status: result.success ? "cancelled" : "failed", result };
        }

        // Legacy fallback: some historical orders stored raw GPS IDs in metafields
        // like gpsorderid / gpsukorderid instead of battle_bus.gps_order JSON.
        const legacyMetafields = await shopify.getOrderMetafields(shopifyOrderId).catch(() => []);
        const readLegacyValue = (candidates: string[]): string | null => {
          const hit = legacyMetafields.find((mf: any) => {
            const key = String(mf?.key || "").toLowerCase();
            return candidates.some((candidate) => key === candidate || key.includes(candidate));
          });
          if (!hit?.value) return null;
          const raw = String(hit.value).trim();
          return raw.length > 0 ? raw : null;
        };

        const legacyUkId = readLegacyValue(["gpsukorderid", "gps_uk_order_id"]);
        const legacyUsId = readLegacyValue(["gpsorderid", "gps_order_id"]);

        const legacyCandidates: Array<{
          orderNumber: string;
          warehouse: "GPS Warehouse" | "GPS UK Warehouse";
          source: string;
        }> = [];
        if (legacyUkId) {
          legacyCandidates.push({
            orderNumber: legacyUkId,
            warehouse: "GPS UK Warehouse",
            source: "legacy_metafield:gpsukorderid",
          });
        }
        if (legacyUsId) {
          legacyCandidates.push({
            orderNumber: legacyUsId,
            warehouse: "GPS Warehouse",
            source: "legacy_metafield:gpsorderid",
          });
        }

        if (legacyCandidates.length > 0) {
          const attempts: Array<{
            orderNumber: string;
            warehouse: "GPS Warehouse" | "GPS UK Warehouse";
            success: boolean;
            message: string;
            source: string;
          }> = [];

          for (const candidate of legacyCandidates) {
            try {
              const result = await gps.cancelOutboundOrder(
                candidate.orderNumber,
                candidate.warehouse
              );
              attempts.push({
                orderNumber: candidate.orderNumber,
                warehouse: candidate.warehouse,
                success: result.success,
                message: result.message,
                source: candidate.source,
              });
              if (result.success) {
                return {
                  status: "cancelled",
                  result,
                  via: candidate.source,
                  warehouse: candidate.warehouse,
                };
              }
            } catch (legacyError) {
              attempts.push({
                orderNumber: candidate.orderNumber,
                warehouse: candidate.warehouse,
                success: false,
                message:
                  legacyError instanceof Error ? legacyError.message : String(legacyError),
                source: candidate.source,
              });
            }
          }

          return {
            status: "failed",
            reason: "Legacy GPS metafield IDs found but cancellation failed",
            attempts,
          };
        }

        if (!gpsMeta?.gpsOrderId) {
          // Fallback: older orders may miss GPS metafields.
          // Try cancellation using Shopify order name as outbound order number.
          const countryCode = (shopifyOrderPayload as any)?.shipping_address?.country_code || "";
          const primaryWarehouse: "GPS Warehouse" | "GPS UK Warehouse" =
            countryCode === "GB" ? "GPS UK Warehouse" : "GPS Warehouse";
          const secondaryWarehouse: "GPS Warehouse" | "GPS UK Warehouse" =
            primaryWarehouse === "GPS UK Warehouse" ? "GPS Warehouse" : "GPS UK Warehouse";

          const attempts: Array<{
            warehouse: "GPS Warehouse" | "GPS UK Warehouse";
            success: boolean;
            message: string;
          }> = [];

          for (const warehouse of [primaryWarehouse, secondaryWarehouse]) {
            try {
              const fallbackResult = await gps.cancelOutboundOrder(shopifyOrderName, warehouse);
              attempts.push({
                warehouse,
                success: fallbackResult.success,
                message: fallbackResult.message,
              });

              if (fallbackResult.success) {
                return {
                  status: "cancelled",
                  result: fallbackResult,
                  via: "fallback_shopify_order_name",
                  warehouse,
                };
              }
            } catch (fallbackError) {
              attempts.push({
                warehouse,
                success: false,
                message:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
              });
            }
          }

          return {
            status: "skipped",
            reason:
              "No GPS order metadata found (battle_bus.gps_order or gpsorderid/gpsukorderid); fallback cancellation not confirmed",
            attempts,
          };
        }
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          note: "Order may already be shipped or not found in GPS",
        };
      }
    });

    // 3. Handle D365 Cancellation or Return
    const d365Cancellation = await step.run("process-d365-cancellation", async () => {
      if (!config.features.enableDynamicsSync || !d365Order) {
        return { status: "skipped", reason: "Dynamics sync disabled or order not found" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;
      const isGpsCancelled =
        gpsCancellation.status === "cancelled" || gpsCancellation.status === "skipped";

      if (isGpsCancelled) {
        // Case A: GPS Cancelled (or was never sent to GPS) → Delete D365 Sales Order
        // D365 sales orders can be deleted if they haven't been confirmed/posted yet.
        // If already confirmed, D365 will return an error — catch and fall through to return order.
        try {
          await dynamics.deleteSalesOrderHeaderV3(dataAreaId, d365Order.SalesOrderNumber!);
          console.log(
            `[Cancellation] ✅ D365 order deleted: ${d365Order.SalesOrderNumber} for ${shopifyOrderName}`
          );
          return {
            status: "success",
            action: "cancel_order",
            salesOrderNumber: d365Order.SalesOrderNumber,
            cancelReason: cancelReason || "Customer Request",
          };
        } catch (deleteErr: any) {
          // Order may already be confirmed/posted — log and escalate to Slack
          console.warn(
            `[Cancellation] ⚠️  Could not delete D365 order ${d365Order.SalesOrderNumber}: ${deleteErr.message}. Order may be confirmed — manual action required.`
          );
          await slack.sendWarningMessage(
            SlackChannelEnum.DYNAMICS,
            `[Cancellation] D365 order ${d365Order.SalesOrderNumber} (${shopifyOrderName}) could not be auto-cancelled — manual action required. GPS was cancelled. Reason: ${deleteErr.message}`
          );
          return {
            status: "manual_required",
            action: "cancel_order",
            salesOrderNumber: d365Order.SalesOrderNumber,
            error: deleteErr.message,
          };
        }
      } else {
        // Case B: GPS cancellation failed (typically already shipped/processing in warehouse).
        // Restore order in Shopify so customer service sees it as active.
        try {
          await shopify.uncancelOrder(shopifyOrderId);
          await slack.sendWarningMessage(
            SlackChannelEnum.GPS,
            `[Cancellation] Shopify order ${shopifyOrderName} (${shopifyOrderId}) was uncancelled because GPS cancellation failed (likely already shipped/in-flight).`
          );
          return {
            status: "manual_required",
            action: "shopify_uncancelled",
            reason: "gps_cancel_failed_order_restored",
            gpsMessage:
              gpsCancellation.status === "failed"
                ? gpsCancellation.error || gpsCancellation.result?.message
                : "GPS cancellation was not successful",
          };
        } catch (uncancelError: any) {
          await slack.sendWarningMessage(
            SlackChannelEnum.GPS,
            `[Cancellation] GPS cancellation failed and Shopify uncancel also failed for ${shopifyOrderName} (${shopifyOrderId}). Manual intervention required. Error: ${uncancelError.message}`
          );
          return {
            status: "manual_required",
            action: "shopify_uncancel_failed",
            reason: "gps_cancel_failed_uncancel_failed",
            error: uncancelError.message,
          };
        }
      }
    });

    const cancellationReverted =
      d365Cancellation?.action === "shopify_uncancelled" ||
      d365Cancellation?.action === "shopify_uncancel_failed";

    const result = {
      status: cancellationReverted
        ? "reverted"
        : d365Cancellation.status === "success" || d365Cancellation.status === "manual_required"
          ? "success"
          : "partial",
      shopifyOrderId,
      shopifyOrderName,
      cancelReason,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      gpsCancellation,
      d365Cancellation,
      processedAt: new Date().toISOString(),
    };

    // Send cancellation event to CS platform with Shopify status
    if (result.status === "success" || result.status === "partial") {
      await csPlatform.sendOrderCancelled({
        orderId: shopifyOrderId,
        shopifyOrderName,
        reason: cancelReason,
        shopifyFinancialStatus: shopifyOrderPayload?.financial_status,
        shopifyCancelledAt: shopifyOrderPayload?.cancelled_at || undefined,
      });
    }

    return result;
  }
);
