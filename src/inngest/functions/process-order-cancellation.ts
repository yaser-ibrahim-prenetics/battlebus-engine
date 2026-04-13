import { inngest } from "../client";
import { config } from "@/lib/config";
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
import { storePendingAction } from "@/lib/services/pending-actions";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

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
    triggers: [{ event: "shopify/order.cancelled" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { shopifyOrderId, shopifyOrderName, cancelReason, orderJson } = event.data;
    const shopifyOrderPayload = orderJson as ShopifyOrderPayload;
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const isGpsWarehouse = (name?: string | null): name is "GPS Warehouse" | "GPS UK Warehouse" =>
      name === "GPS Warehouse" || name === "GPS UK Warehouse";

    await logFlowEvent({ flow: "cancellation", step: "start", status: "started", runId: _runId, shopifyOrderId: String(shopifyOrderId), shopifyOrderName, payload: { cancelReason } });

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
      };
    }

    // 1. Cancel GPS Order (only for GPS orders — no D365 action on cancel)
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
        const legacyMetafields = await shopify.getOrderMetafields(shopifyOrderId).catch((error) => {
          console.warn('[Cancellation] Fetch failed, continuing:', error instanceof Error ? error.message : error);
          return [];
        });
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

    // If GPS has nothing to act on and this is not a drain replay,
    // the GPS order creation likely hasn't completed yet — defer.
    const nothingToCancelInGps =
      gpsCancellation.status === "skipped" &&
      typeof gpsCancellation.reason === "string" &&
      gpsCancellation.reason.includes("No GPS order metadata");
    const isFromDrain = !!(event.data as any).fromDrain;

    if (nothingToCancelInGps && config.features.enableGpsSync && !isFromDrain) {
      await step.run("store-pending-cancel", async () => {
        await storePendingAction(shopifyOrderId, {
          action: "cancel",
          eventName: "shopify/order.cancelled",
          eventData: event.data,
          createdAt: new Date().toISOString(),
        });
      });
      console.log(
        `[PendingActions] Deferred cancellation for ${shopifyOrderName} — GPS order not yet created`
      );
      return {
        status: "deferred",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
        reason: "GPS order not yet created, cancellation queued for replay",
      };
    }

    // 2. If GPS cancel failed, uncancel in Shopify to keep state aligned with warehouse
    if (gpsCancellation.status === "failed") {
      await step.run("uncancel-shopify-order", async () => {
        try {
          await shopify.uncancelOrder(shopifyOrderId);
          await slack.sendWarningMessage(
            SlackChannelEnum.GPS,
            `[Cancellation] Shopify order ${shopifyOrderName} (${shopifyOrderId}) was uncancelled because GPS cancellation failed (likely already shipped/in-flight).`
          );
        } catch (uncancelError: any) {
          await slack.sendWarningMessage(
            SlackChannelEnum.GPS,
            `[Cancellation] GPS cancellation failed and Shopify uncancel also failed for ${shopifyOrderName} (${shopifyOrderId}). Manual intervention required. Error: ${uncancelError.message}`
          );
        }
      });

      return {
        status: "reverted",
        shopifyOrderId,
        shopifyOrderName,
        cancelReason,
        gpsCancellation,
        reason: "GPS cancel failed — Shopify order restored",
        processedAt: new Date().toISOString(),
      };
    }

    const result = {
      status: gpsCancellation.status === "cancelled" ? "success" : "success",
      shopifyOrderId,
      shopifyOrderName,
      cancelReason,
      gpsCancellation,
      processedAt: new Date().toISOString(),
    };

    // 3. Notify CS platform
    await csPlatform.sendOrderCancelled({
      orderId: shopifyOrderId,
      shopifyOrderName,
      reason: cancelReason,
      shopifyFinancialStatus: shopifyOrderPayload?.financial_status,
      shopifyCancelledAt: shopifyOrderPayload?.cancelled_at || undefined,
    });

    await logFlowEvent({ flow: "cancellation", step: "done", status: "completed", runId: _runId, shopifyOrderId: String(shopifyOrderId), shopifyOrderName, durationMs: Date.now() - _flowStart, payload: { gpsCancellationStatus: gpsCancellation.status } });
    return result;
  }
);
