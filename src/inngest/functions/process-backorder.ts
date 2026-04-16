// ============================================================================
// BACKORDER PROCESSOR
// ============================================================================
// Handles orders that failed GPS warehouse sync due to inventory issues.
// Replaces the spock-store pattern of daily task rescheduling with
// Inngest's durable step.waitForEvent + step.sleep for multi-attempt retries.
//
// Error patterns handled (from spock-store and GPS API):
//   库存不足 = insufficient inventory
//   未维护新品 = unmaintained new product (SKU not registered in GPS)
//   "cannot be reserved" = D365 inventory reservation failure
//
// Flow:
// 1. Order fails GPS sync → backorder/created event emitted
// 2. This function picks it up and enters a retry loop
// 3. Each iteration: wait for either a manual retry event OR a timeout
// 4. On timeout: auto-retry GPS order creation
// 5. After max retries: escalate to Slack and mark as exhausted

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import { setGpsOrderMetafield } from "@/lib/clients/shopify";
import { toGpsOutboundOrder, shouldSendToGps } from "@/lib/transformers/order";
import { SlackChannelEnum } from "@/lib/types/slack";
import { RETRY_CONFIGS, BACKORDER_CONFIGS } from "@/lib/utils/constants";
import type { ShopifyOrderPayload } from "../events";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

export const processBackorder = inngest.createFunction(
  {
    id: "process-backorder",
    name: "Process Backorder (Inventory Retry)",
    // Use unique event ID so each manual retry event always triggers a run.
    idempotency: "event.id",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: "backorder/created" }, { event: "backorder/retry" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const {
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber,
      warehouse,
      errorMessage,
      errorType,
    } = event.data;

    const failedSkus: string[] = Array.isArray(event.data.failedSkus) ? event.data.failedSkus : [];

    const autoRetryEnabled = BACKORDER_CONFIGS.autoRetryEnabled;
    // Respect explicit maxRetries=0 from producer (park only, no auto-retry).
    const maxRetries = event.data.maxRetries ??
      (autoRetryEnabled ? BACKORDER_CONFIGS.autoRetryMaxAttempts : BACKORDER_CONFIGS.maxRetries);
    const retryIntervalHours = autoRetryEnabled
      ? BACKORDER_CONFIGS.autoRetryIntervalHours
      : BACKORDER_CONFIGS.retryIntervalHours;
    const waitTimeoutHours = BACKORDER_CONFIGS.waitForEventTimeoutHours;
    let retryCount = event.data.retryCount || 0;
    const isManualRetryRequest =
      event.name === "backorder/retry" ||
      event.data.triggeredBy === "manual" ||
      event.data.triggeredBy === "manual_bulk";
    const manualRetryOnly = !autoRetryEnabled;

    const _flowStart = Date.now();
    const _runId = (event as any).id;

    logFlowEvent({ flow: "backorder", step: "start", status: "started", runId: _runId, shopifyOrderId: String(shopifyOrderId), shopifyOrderName, d365OrderNumber, payload: { errorType, warehouse, retryCount } });

    console.log(`[Backorder] ========================================`);
    console.log(`[Backorder] Processing backorder for ${shopifyOrderName}`);
    console.log(`[Backorder] Error: ${errorType} - ${errorMessage}`);
    console.log(
      `[Backorder] Failed SKUs: ${failedSkus.length > 0 ? failedSkus.join(", ") : "(all lines)"}`
    );
    console.log(`[Backorder] Retry ${retryCount}/${maxRetries}`);

    // Notify Battle Hub when first parked in backorder queue.
    if (event.name === "backorder/created") {
      await step.run("notify-hub-backorder-created", async () => {
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber,
            warehouse,
            status: "backorder",
            error: errorMessage,
            errorType,
          },
          {}
        );
      });
    }

    // Manual-only mode: orders stay parked until Hub explicitly requests retry.
    if (manualRetryOnly && !isManualRetryRequest) {
      await step.run("notify-backorder-parked-manual-only", async () => {
        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `[Backorder parked - manual retry only] ${shopifyOrderName}\n` +
            `Error: ${errorType} - ${errorMessage}\n` +
            `Warehouse: ${warehouse}\n` +
            `D365: ${d365OrderNumber}`
        );
      });

      return {
        status: "parked_manual_only",
        shopifyOrderId,
        shopifyOrderName,
        errorType,
        retryCount: 0,
        processedAt: new Date().toISOString(),
      };
    }

    // Manual retry request: perform exactly one retry attempt.
    if (manualRetryOnly && isManualRetryRequest) {
      const manualAttempt = retryCount + 1;
      const retryResult = await step.run(`manual-retry-gps-order-${manualAttempt}`, async () => {
        try {
          const { getOrder } = await import("@/lib/clients/shopify");
          const freshOrder = await getOrder(shopifyOrderId);
          const order = freshOrder as unknown as ShopifyOrderPayload;

          const gpsPayload = toGpsOutboundOrder(order, d365OrderNumber, warehouse);
          const result = await gps.createOutboundOrder(
            gpsPayload,
            warehouse as "GPS Warehouse" | "GPS UK Warehouse"
          );

          const gpsOrderNo = result?.response?.data?.[0]?.orderNo;
          if (gpsOrderNo) {
            await setGpsOrderMetafield(shopifyOrderId, {
              gpsOrderId: gpsOrderNo,
              warehouse,
              d365OrderNumber,
              createdAt: new Date().toISOString(),
            });
          }

          return { success: true, gpsOrderNo };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: msg,
            isInventoryError: gps.isGpsInventoryError(msg),
          };
        }
      });

      if (retryResult.success) {
        await step.run("notify-backorder-resolved-manual", async () => {
          await slack.sendOrderMessage(
            SlackChannelEnum.SHOPIFY,
            `Backorder resolved (manual retry): ${shopifyOrderName} (GPS: ${retryResult.gpsOrderNo})`
          );
          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber,
              warehouse,
              gpsOrderId: retryResult.gpsOrderNo,
              gpsSyncStatus: "synced",
              status: "processing",
              error: undefined,
              errorType: undefined,
            },
            {}
          );
        });

        await inngest.send({
          name: "backorder/resolved",
          data: {
            shopifyOrderId,
            shopifyOrderName,
            resolvedAt: new Date().toISOString(),
            resolution: "manual",
          },
        });

        // Pending lifecycle actions drained by the cron sweep — no explicit trigger needed.

        return {
          status: "resolved",
          shopifyOrderId,
          shopifyOrderName,
          gpsOrderNo: retryResult.gpsOrderNo,
          retryCount: manualAttempt,
          processedAt: new Date().toISOString(),
        };
      }

      // Still inventory-related: keep parked in queue, no automatic requeue.
      if (retryResult.isInventoryError) {
        await step.run("notify-hub-manual-retry-still-backorder", async () => {
          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber,
              warehouse,
              status: "backorder",
              error: retryResult.error,
              errorType,
            },
            {}
          );
        });

        return {
          status: "still_backorder",
          shopifyOrderId,
          shopifyOrderName,
          error: retryResult.error,
          retryCount: manualAttempt,
          processedAt: new Date().toISOString(),
        };
      }

      await step.run("notify-manual-retry-non-inventory-error", async () => {
        await slack.sendErrorMessage(
          SlackChannelEnum.SHOPIFY,
          `[Backorder] Non-inventory error on manual retry for ${shopifyOrderName}:\n${retryResult.error}`
        );
      });

      return {
        status: "error",
        shopifyOrderId,
        shopifyOrderName,
        error: retryResult.error,
        retryCount: manualAttempt,
        reason: "Non-inventory error — requires manual investigation",
        processedAt: new Date().toISOString(),
      };
    }

    // No auto-retry mode: keep order parked in backorder queue for manual action only.
    if (maxRetries <= 0) {
      await step.run("notify-backorder-parked-no-retry", async () => {
        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `[Backorder parked - no auto-retry] ${shopifyOrderName}\n` +
            `Error: ${errorType} - ${errorMessage}\n` +
            `Warehouse: ${warehouse}\n` +
            `D365: ${d365OrderNumber}`
        );
      });

      return {
        status: "parked_no_retry",
        shopifyOrderId,
        shopifyOrderName,
        errorType,
        retryCount: 0,
        processedAt: new Date().toISOString(),
      };
    }

    // Retry loop
    while (retryCount < maxRetries) {
      retryCount++;

      console.log(
        `[Backorder] Waiting for retry event or timeout (${waitTimeoutHours}h) - attempt ${retryCount}/${maxRetries}`
      );

      // Wait for either:
      // 1. A manual retry event from Battle Hub (backorder/retry)
      // 2. A stock replenishment signal (inventory/sync with matching SKU)
      // 3. Timeout after configured hours → auto-retry
      const waitResult = await step.waitForEvent(`wait-for-retry-${retryCount}`, {
        event: "backorder/retry",
        match: "data.shopifyOrderId",
        timeout: `${retryIntervalHours}h`,
      });

      const triggeredBy = waitResult ? "manual" : "auto";
      console.log(`[Backorder] Retry ${retryCount} triggered by: ${triggeredBy}`);

      // Attempt GPS order creation
      const retryResult = await step.run(`retry-gps-order-${retryCount}`, async () => {
        try {
          // Refetch order from Shopify for latest data
          const { getOrder } = await import("@/lib/clients/shopify");
          const freshOrder = await getOrder(shopifyOrderId);
          const order = freshOrder as unknown as ShopifyOrderPayload;

          // Rebuild GPS payload
          const gpsPayload = toGpsOutboundOrder(order, d365OrderNumber, warehouse);
          const result = await gps.createOutboundOrder(
            gpsPayload,
            warehouse as "GPS Warehouse" | "GPS UK Warehouse"
          );

          // Store GPS metafield on success
          const gpsOrderNo = result?.response?.data?.[0]?.orderNo;
          if (gpsOrderNo) {
            await setGpsOrderMetafield(shopifyOrderId, {
              gpsOrderId: gpsOrderNo,
              warehouse,
              d365OrderNumber,
              createdAt: new Date().toISOString(),
            });
          }

          return {
            success: true,
            gpsOrderNo,
            retryCount,
            triggeredBy,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`[Backorder] Retry ${retryCount} failed: ${msg}`);

          return {
            success: false,
            error: msg,
            isInventoryError: gps.isGpsInventoryError(msg),
            retryCount,
            triggeredBy,
          };
        }
      });

      if (retryResult.success) {
        // Resolved
        console.log(`[Backorder] Order ${shopifyOrderName} resolved on retry ${retryCount}`);

        await step.run("notify-backorder-resolved", async () => {
          await slack.sendOrderMessage(
            SlackChannelEnum.SHOPIFY,
            `Backorder resolved: ${shopifyOrderName} after ${retryCount} retries (GPS: ${retryResult.gpsOrderNo})`
          );

          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber,
              warehouse,
              gpsOrderId: retryResult.gpsOrderNo,
              gpsSyncStatus: "synced",
              status: "processing",
              error: undefined,
              errorType: undefined,
            },
            {}
          );
        });

        // Emit resolved event
        await inngest.send({
          name: "backorder/resolved",
          data: {
            shopifyOrderId,
            shopifyOrderName,
            resolvedAt: new Date().toISOString(),
            resolution: "fulfilled",
          },
        });

        // Pending lifecycle actions drained by the cron sweep — no explicit trigger needed.

        return {
          status: "resolved",
          shopifyOrderId,
          shopifyOrderName,
          gpsOrderNo: retryResult.gpsOrderNo,
          retryCount,
          processedAt: new Date().toISOString(),
        };
      }

      // If it's not an inventory error anymore, something else is wrong — escalate immediately
      if (!retryResult.isInventoryError) {
        console.log(`[Backorder] Non-inventory error on retry ${retryCount}, escalating`);

        await step.run("notify-non-inventory-error", async () => {
          await slack.sendErrorMessage(
            SlackChannelEnum.SHOPIFY,
            `[Backorder] Non-inventory error for ${shopifyOrderName} on retry ${retryCount}/${maxRetries}:\n${retryResult.error}`
          );
        });

        return {
          status: "error",
          shopifyOrderId,
          shopifyOrderName,
          error: retryResult.error,
          retryCount,
          reason: "Non-inventory error — requires manual investigation",
          processedAt: new Date().toISOString(),
        };
      }

      // Update Battle Hub with retry status
      await step.run(`notify-hub-retry-${retryCount}`, async () => {
        const nextRetryAt =
          retryCount < maxRetries
            ? new Date(Date.now() + retryIntervalHours * 60 * 60 * 1000).toISOString()
            : undefined;

        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber,
            warehouse,
            status: "backorder",
            error: retryResult.error,
            errorType,
            retryAt: nextRetryAt,
          },
          {}
        );
      });
    }

    // Max retries exhausted — escalate
    console.log(`[Backorder] Max retries (${maxRetries}) exhausted for ${shopifyOrderName}`);

    await step.run("notify-backorder-exhausted", async () => {
      await slack.sendErrorMessage(
        "gpslow",
        `[Backorder EXHAUSTED] ${shopifyOrderName}\n` +
          `Error: ${errorType} - ${errorMessage}\n` +
          `SKUs: ${failedSkus.join(", ")}\n` +
          `Warehouse: ${warehouse}\n` +
          `D365: ${d365OrderNumber}\n` +
          `Retried ${maxRetries} times over ${maxRetries * retryIntervalHours}h\n` +
          `Action Required: Manual intervention needed`
      );

      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber,
          warehouse,
          status: "backorder_exhausted",
          error: errorMessage,
          errorType,
        },
        {}
      );
    });

    logFlowEvent({ flow: "backorder", step: "done", status: "failed", level: "error", runId: _runId, shopifyOrderId: String(shopifyOrderId), shopifyOrderName, d365OrderNumber, durationMs: Date.now() - _flowStart, errorType, errorMessage, payload: { retryCount: maxRetries } });
    return {
      status: "exhausted",
      shopifyOrderId,
      shopifyOrderName,
      errorType,
      errorMessage,
      retryCount: maxRetries,
      processedAt: new Date().toISOString(),
    };
  }
);
