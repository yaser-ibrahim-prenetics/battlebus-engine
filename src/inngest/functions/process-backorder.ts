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
// 3. Automatic recovery sleeps durably between bounded attempts
// 4. Manual retry events run in a dedicated worker
// 5. After max retries: escalate to Slack and mark as exhausted

import { inngest } from "../client";
import { readPlan } from "@/lib/services/order-segments/store";
import { processOrderSegments } from "@/lib/services/order-segments/process";
import { loadOrderAccounting } from "@/lib/services/order-accounting/load";
import { loadSaudiShortAddress } from "@/lib/services/saudi-short-address";
import { loadEligibleRecoveryOrder } from "@/lib/services/order-segments/recovery";
import { resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import { config } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import { getOrderMetafields, setGpsOrderMetafield } from "@/lib/clients/shopify";
import { toGpsOutboundOrder } from "@/lib/transformers/order";
import { getIm8ShortAddressFromMetafields } from "@/lib/transformers/address";
import { SlackChannelEnum } from "@/lib/types/slack";
import { RETRY_CONFIGS, BACKORDER_CONFIGS } from "@/lib/utils/constants";
import type { RunSequenceStage, ShopifyOrderPayload } from "../events";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { advanceRunSequence } from "@/lib/services/run-sequence";
import {
  acquireBackorderRecoveryLease,
  isBackorderRecoveryBusyError,
  releaseBackorderRecoveryLease,
  renewBackorderRecoveryLease,
  type BackorderRecoveryLease,
} from "@/lib/services/backorder-recovery/lease";

type LeaseAcquisitionResult =
  | { status: "acquired"; lease: BackorderRecoveryLease }
  | { status: "busy"; retryAt: string };

function secondsUntil(retryAt: string): number {
  const remaining = Math.ceil((Date.parse(retryAt) - Date.now()) / 1_000) + 1;
  return Number.isFinite(remaining) ? Math.max(1, Math.min(3_600, remaining)) : 1;
}

async function buildBackorderGpsPayload(params: {
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyStore?: string;
  d365OrderNumber: string;
  warehouse: string;
}) {
  const shortAddress =
    params.order.shipping_address?.country_code === "SA"
      ? getIm8ShortAddressFromMetafields(
          await getOrderMetafields(params.shopifyOrderId, params.shopifyStore)
        )
      : "";

  return toGpsOutboundOrder(params.order, params.d365OrderNumber, params.warehouse, shortAddress);
}

async function handleBackorder({ event, step, runId }: { event: any; step: any; runId?: string }) {
  const { shopifyOrderId, shopifyOrderName, d365OrderNumber, warehouse, errorMessage, errorType } =
    event.data;

  if (!BACKORDER_CONFIGS.enabled) {
    return {
      status: "disabled",
      shopifyOrderId,
      shopifyOrderName,
      processedAt: new Date().toISOString(),
    };
  }

  const failedSkus: string[] = Array.isArray(event.data.failedSkus) ? event.data.failedSkus : [];

  const autoRetryEnabled = BACKORDER_CONFIGS.autoRetryEnabled;
  // Respect explicit maxRetries=0 from producer (park only, no auto-retry).
  const maxRetries =
    event.data.maxRetries ??
    (autoRetryEnabled ? BACKORDER_CONFIGS.autoRetryMaxAttempts : BACKORDER_CONFIGS.maxRetries);
  const retryIntervalHours = autoRetryEnabled
    ? BACKORDER_CONFIGS.autoRetryIntervalHours
    : BACKORDER_CONFIGS.retryIntervalHours;
  let retryCount = event.data.retryCount || 0;
  const isManualRetryRequest =
    event.name === "backorder/retry" ||
    event.data.triggeredBy === "manual" ||
    event.data.triggeredBy === "manual_bulk";
  const backorderQueueTag = event.data.backorderQueue;
  const manualRetryOnly = !autoRetryEnabled;
  const defaultFailureSystem: "d365" | "gps" | "validation" =
    event.data.failureStage === "fulfillment" ||
    event.data.sourceEventName === "shopify/order.fulfilled" ||
    (typeof event.data.sourceEventName === "string" &&
      event.data.sourceEventName.includes("fulfilled"))
      ? "d365"
      : "gps";
  const explicitRetryMode = event.data.retryMode;
  const derivedRetryMode: "gps_outbound" | "fulfillment_replay" =
    event.data.failureStage === "fulfillment" ||
    event.data.sourceEventName === "shopify/order.fulfilled"
      ? "fulfillment_replay"
      : "gps_outbound";
  const effectiveRetryMode: "gps_outbound" | "fulfillment_replay" =
    explicitRetryMode === "fulfillment_replay" || explicitRetryMode === "gps_outbound"
      ? explicitRetryMode
      : derivedRetryMode;

  const _flowStart = Date.now();
  const _runId = String(runId ?? "");
  const shop = resolveShopifyAdminCredentials(event.data.shopifyStore).shopDomain;
  const leaseOwner = `${event.name}:${_runId || event.id}`;
  const acquireLease = async (operationSuffix: string): Promise<BackorderRecoveryLease> => {
    let waitAttempt = 0;
    while (true) {
      const result = (await step.run(
        `acquire-backorder-lease-${operationSuffix}-${waitAttempt}`,
        async (): Promise<LeaseAcquisitionResult> => {
          try {
            return {
              status: "acquired",
              lease: await acquireBackorderRecoveryLease({
                shopifyStore: shop,
                orderId: String(shopifyOrderId),
                operationKey: `${event.id}:${operationSuffix}`,
                owner: leaseOwner,
                leaseSeconds: BACKORDER_CONFIGS.recoveryLeaseSeconds,
              }),
            };
          } catch (error) {
            if (!isBackorderRecoveryBusyError(error)) throw error;
            return { status: "busy", retryAt: error.retryAt };
          }
        }
      )) as LeaseAcquisitionResult;
      if (result.status === "acquired") return result.lease;

      await step.sleep(
        `wait-for-backorder-lease-${operationSuffix}-${waitAttempt}`,
        `${secondsUntil(result.retryAt)}s`
      );
      waitAttempt++;
    }
  };
  const releaseLease = (lease: BackorderRecoveryLease) => releaseBackorderRecoveryLease(lease);

  if (effectiveRetryMode === "gps_outbound" && !config.features.dryRunMode) {
    const segmented = await readPlan(shop, String(shopifyOrderId));
    if (segmented && isManualRetryRequest) {
      const lease = await acquireLease("segment-recovery");
      const ensureLease = () => renewBackorderRecoveryLease(lease);
      const ensureEligible = () =>
        loadEligibleRecoveryOrder(shop, String(shopifyOrderId), segmented.plan.inputHash);
      const latest = await ensureEligible();
      const accounting = await step.run("reload-segment-accounting", () =>
        loadOrderAccounting(latest as unknown as ShopifyOrderPayload, shop)
      );
      const shortAddress = await loadSaudiShortAddress({
        step,
        order: latest as unknown as ShopifyOrderPayload,
        shopifyOrderId: String(shopifyOrderId),
        shopifyStore: shop,
      });
      const result = await processOrderSegments({
        order: latest as unknown as ShopifyOrderPayload,
        step,
        accounting,
        shopDomain: shop,
        fallbackDataArea: segmented.plan.segments[0].dataAreaId,
        shortAddress,
        ensureEligible,
        beforeExternalMutation: ensureLease,
      });
      await step.run("release-segment-recovery-lease", () => releaseLease(lease));
      return result;
    }
    if (segmented)
      return {
        status: "segment_recovery_required",
        reason:
          "Replay the order or use manual backorder recovery to resume its durable segment plan",
      };
  }

  logFlowEvent({
    flow: "backorder",
    step: "start",
    status: "started",
    runId: _runId || undefined,
    shopifyOrderId: String(shopifyOrderId),
    shopifyOrderName,
    d365OrderNumber,
    payload: { errorType, warehouse, retryCount },
  });

  console.log(`[Backorder] ========================================`);
  console.log(`[Backorder] Processing backorder for ${shopifyOrderName}`);
  console.log(`[Backorder] Error: ${errorType} - ${errorMessage}`);
  console.log(
    `[Backorder] Failed SKUs: ${failedSkus.length > 0 ? failedSkus.join(", ") : "(all lines)"}`
  );
  console.log(`[Backorder] Retry ${retryCount}/${maxRetries}`);

  // ────────────────────────────────────────────────────────────────────────
  // Sequenced rerun: if the manual retry came with a `runSequence`, dispatch
  // the first stage's pipeline event and persist the timeline. Each upstream
  // handler will hand off to the next stage on success via advanceRunSequence.
  // ────────────────────────────────────────────────────────────────────────
  const incomingSequence: RunSequenceStage[] = Array.isArray(event.data.runSequence)
    ? (event.data.runSequence as RunSequenceStage[])
    : [];
  if (incomingSequence.length > 0 && event.name === "backorder/retry") {
    const lease = await acquireLease("sequenced-rerun");
    const result = await step.run("dispatch-sequenced-rerun", async () => {
      await renewBackorderRecoveryLease(lease);
      const { getOrder } = await import("@/lib/clients/shopify");
      const freshOrder = (await getOrder(
        shopifyOrderId,
        event.data.shopifyStore
      )) as unknown as ShopifyOrderPayload;
      const fulfillments = Array.isArray((freshOrder as any)?.fulfillments)
        ? ((freshOrder as any).fulfillments as any[])
        : [];

      return advanceRunSequence({
        shopifyOrderId,
        shopifyOrderName,
        remaining: incomingSequence,
        orderJson: freshOrder,
        fulfillments,
        shopifyStore: shop,
        inngestRunId: _runId || undefined,
      });
    });
    await step.run("release-sequenced-rerun-lease", () => releaseLease(lease));

    await csPlatform.sendOrderUpdate(
      {
        id: shopifyOrderId,
        name: shopifyOrderName,
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber,
        warehouse,
        status: "processing",
        processingStatus: "processing",
        retryAt: null,
        ...(backorderQueueTag === "sync" || backorderQueueTag === "fulfilment"
          ? {
              state: {
                failureContext: { backorderQueue: backorderQueueTag },
              },
            }
          : {}),
      },
      {}
    );

    logFlowEvent({
      flow: "backorder",
      step: "sequenced-rerun-dispatched",
      status: "completed",
      runId: _runId || undefined,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      durationMs: Date.now() - _flowStart,
      payload: {
        firstStage: result.dispatched?.stage,
        totalStages: incomingSequence.length,
      },
    });

    return {
      status: "sequenced_dispatched",
      shopifyOrderId,
      shopifyOrderName,
      firstStage: result.dispatched?.stage,
      totalStages: incomingSequence.length,
      processedAt: new Date().toISOString(),
    };
  }

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
          state: {
            failureContext: {
              stage: event.data.failureStage || "order_creation",
              system: event.data.failureSystem || defaultFailureSystem,
              sourceEventName: event.data.sourceEventName || event.name,
              retryMode: effectiveRetryMode,
              ...(backorderQueueTag === "sync" || backorderQueueTag === "fulfilment"
                ? { backorderQueue: backorderQueueTag }
                : {}),
            },
          },
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
          `D365: ${d365OrderNumber}`,
        slack.slackNotificationId(event.id, "backorder-parked-manual-only")
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
  if (isManualRetryRequest) {
    const manualAttempt = retryCount + 1;
    const lease = await acquireLease(`manual-retry:${manualAttempt}`);
    const retryResult = await step.run(`manual-retry-gps-order-${manualAttempt}`, async () => {
      await renewBackorderRecoveryLease(lease);
      try {
        const { getOrder } = await import("@/lib/clients/shopify");
        const freshOrder = await getOrder(shopifyOrderId, event.data.shopifyStore);
        const order = freshOrder as unknown as ShopifyOrderPayload;

        const d365NumManual = String(d365OrderNumber || "").trim();
        if (effectiveRetryMode === "gps_outbound" && !d365NumManual) {
          await inngest.send({
            id: `backorder-retry:${event.id}:shopify-order-paid`,
            name: "shopify/order.paid",
            data: {
              shopifyOrderId: String(shopifyOrderId),
              shopifyOrderName,
              shopifyStore: event.data.shopifyStore || "im8-battle-bus",
              orderJson: order,
              receivedAt: new Date().toISOString(),
            },
          });
          return { success: true, replayDispatched: true };
        }

        if (effectiveRetryMode === "fulfillment_replay") {
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
            id: `backorder-retry:${event.id}:shopify-order-fulfilled`,
            name: "shopify/order.fulfilled",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              shopifyStore: event.data.shopifyStore || "im8-battle-bus",
              orderJson: order,
              fulfillments,
              receivedAt: new Date().toISOString(),
              fromBackorderRetry: true,
            },
          });

          return { success: true, replayDispatched: true };
        }

        const gpsPayload = await buildBackorderGpsPayload({
          order,
          shopifyOrderId: String(shopifyOrderId),
          shopifyStore: event.data.shopifyStore,
          d365OrderNumber,
          warehouse,
        });
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
          isInventoryError:
            effectiveRetryMode === "fulfillment_replay" ? false : gps.isGpsInventoryError(msg),
        };
      }
    });
    await step.run(`release-manual-retry-lease-${manualAttempt}`, () => releaseLease(lease));

    if (retryResult.success) {
      await step.run("notify-backorder-resolved-manual", async () => {
        const paidReplay =
          effectiveRetryMode === "gps_outbound" && !!(retryResult as any).replayDispatched;
        await slack.sendOrderMessage(
          SlackChannelEnum.SHOPIFY,
          effectiveRetryMode === "fulfillment_replay"
            ? `Backorder replay dispatched (manual retry): ${shopifyOrderName} via shopify/order.fulfilled`
            : paidReplay
              ? `Backorder replay dispatched (manual retry): ${shopifyOrderName} via shopify/order.paid`
              : `Backorder resolved (manual retry): ${shopifyOrderName} (GPS: ${retryResult.gpsOrderNo})`,
          slack.slackNotificationId(event.id, "backorder-resolved-manual", manualAttempt)
        );
        const replayDispatchedManual =
          effectiveRetryMode === "fulfillment_replay" ||
          (effectiveRetryMode === "gps_outbound" && !!(retryResult as any).replayDispatched);
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber,
            warehouse,
            gpsOrderId: retryResult.gpsOrderNo,
            gpsSyncStatus: replayDispatchedManual ? undefined : "synced",
            status: "processing",
            processingStatus: "processing",
            error: undefined,
            lastError: undefined,
            errorType: undefined,
            lastErrorType: undefined,
            retryAt: null,
          },
          {}
        );
      });

      await inngest.send({
        id: `backorder-retry:${event.id}:resolved`,
        name: "backorder/resolved",
        data: {
          shopifyOrderId,
          shopifyOrderName,
          shopifyStore: shop,
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
        replayDispatched: !!(retryResult as any).replayDispatched,
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
            processingStatus: "backorder",
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
        `[Backorder] Non-inventory error on manual retry for ${shopifyOrderName}:\n${retryResult.error}`,
        slack.slackNotificationId(
          event.id,
          "backorder-manual-retry-non-inventory-error",
          manualAttempt
        )
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
          `D365: ${d365OrderNumber}`,
        slack.slackNotificationId(event.id, "backorder-parked-no-retry")
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
      `[Backorder] Waiting ${retryIntervalHours}h before automatic attempt ${retryCount}/${maxRetries}`
    );
    await step.sleep(`wait-before-auto-retry-${retryCount}`, `${retryIntervalHours}h`);
    const triggeredBy = "auto";

    // Attempt GPS order creation
    const lease = await acquireLease(`auto-retry:${retryCount}`);
    const retryResult = await step.run(`retry-gps-order-${retryCount}`, async () => {
      await renewBackorderRecoveryLease(lease);
      try {
        // Refetch order from Shopify for latest data
        const { getOrder } = await import("@/lib/clients/shopify");
        const freshOrder = await getOrder(shopifyOrderId, event.data.shopifyStore);
        const order = freshOrder as unknown as ShopifyOrderPayload;

        const d365NumLoop = String(d365OrderNumber || "").trim();
        if (effectiveRetryMode === "gps_outbound" && !d365NumLoop) {
          await inngest.send({
            id: `backorder-auto:${event.id}:${retryCount}:shopify-order-paid`,
            name: "shopify/order.paid",
            data: {
              shopifyOrderId: String(shopifyOrderId),
              shopifyOrderName,
              shopifyStore: event.data.shopifyStore || "im8-battle-bus",
              orderJson: order,
              receivedAt: new Date().toISOString(),
            },
          });
          return {
            success: true,
            retryCount,
            triggeredBy,
            replayDispatched: true,
          };
        }

        if (effectiveRetryMode === "fulfillment_replay") {
          const fulfillments = Array.isArray((order as any)?.fulfillments)
            ? ((order as any).fulfillments as any[])
            : [];
          if (fulfillments.length === 0) {
            return {
              success: false,
              error: "No Shopify fulfillments found to replay",
              isInventoryError: false,
              retryCount,
              triggeredBy,
            };
          }

          await inngest.send({
            id: `backorder-auto:${event.id}:${retryCount}:shopify-order-fulfilled`,
            name: "shopify/order.fulfilled",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              shopifyStore: event.data.shopifyStore || "im8-battle-bus",
              orderJson: order,
              fulfillments,
              receivedAt: new Date().toISOString(),
              fromBackorderRetry: true,
            },
          });

          return {
            success: true,
            retryCount,
            triggeredBy,
            replayDispatched: true,
          };
        }

        // Rebuild GPS payload
        const gpsPayload = await buildBackorderGpsPayload({
          order,
          shopifyOrderId: String(shopifyOrderId),
          shopifyStore: event.data.shopifyStore,
          d365OrderNumber,
          warehouse,
        });
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
          isInventoryError:
            effectiveRetryMode === "fulfillment_replay" ? false : gps.isGpsInventoryError(msg),
          retryCount,
          triggeredBy,
        };
      }
    });
    await step.run(`release-auto-retry-lease-${retryCount}`, () => releaseLease(lease));

    if (retryResult.success) {
      // Resolved
      console.log(`[Backorder] Order ${shopifyOrderName} resolved on retry ${retryCount}`);

      await step.run("notify-backorder-resolved", async () => {
        const paidReplayLoop =
          effectiveRetryMode === "gps_outbound" && !!(retryResult as any).replayDispatched;
        await slack.sendOrderMessage(
          SlackChannelEnum.SHOPIFY,
          effectiveRetryMode === "fulfillment_replay"
            ? `Backorder replay dispatched: ${shopifyOrderName} after ${retryCount} retries via shopify/order.fulfilled`
            : paidReplayLoop
              ? `Backorder replay dispatched: ${shopifyOrderName} after ${retryCount} retries via shopify/order.paid`
              : `Backorder resolved: ${shopifyOrderName} after ${retryCount} retries (GPS: ${retryResult.gpsOrderNo})`,
          slack.slackNotificationId(event.id, "backorder-resolved", retryCount)
        );

        const replayDispatchedAuto =
          effectiveRetryMode === "fulfillment_replay" ||
          (effectiveRetryMode === "gps_outbound" && !!(retryResult as any).replayDispatched);
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber,
            warehouse,
            gpsOrderId: retryResult.gpsOrderNo,
            gpsSyncStatus: replayDispatchedAuto ? undefined : "synced",
            status: "processing",
            processingStatus: "processing",
            error: undefined,
            lastError: undefined,
            errorType: undefined,
            lastErrorType: undefined,
            retryAt: null,
          },
          {}
        );
      });

      // Emit resolved event
      await inngest.send({
        id: `backorder-auto:${event.id}:${retryCount}:resolved`,
        name: "backorder/resolved",
        data: {
          shopifyOrderId,
          shopifyOrderName,
          shopifyStore: shop,
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
        replayDispatched: !!(retryResult as any).replayDispatched,
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
          `[Backorder] Non-inventory error for ${shopifyOrderName} on retry ${retryCount}/${maxRetries}:\n${retryResult.error}`,
          slack.slackNotificationId(event.id, "backorder-non-inventory-error", retryCount)
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
        `Action Required: Manual intervention needed`,
      slack.slackNotificationId(event.id, "backorder-exhausted")
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

  logFlowEvent({
    flow: "backorder",
    step: "done",
    status: "failed",
    level: "error",
    runId: _runId || undefined,
    shopifyOrderId: String(shopifyOrderId),
    shopifyOrderName,
    d365OrderNumber,
    durationMs: Date.now() - _flowStart,
    errorType,
    errorMessage,
    payload: { retryCount: maxRetries },
  });
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

const backorderConcurrency: [{ limit: number }, { limit: number; key: string }] = [
  { limit: 5 },
  {
    limit: 1,
    key: "event.data.shopifyStore + ':' + event.data.shopifyOrderId",
  },
];

export const processBackorder = inngest.createFunction(
  {
    id: "process-backorder",
    name: "Process Backorder (Automatic Inventory Recovery)",
    idempotency: "event.id",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: backorderConcurrency,
    triggers: [{ event: "backorder/created" }],
    cancelOn: [
      {
        event: "backorder/resolved",
        if: "async.data.shopifyOrderId == event.data.shopifyOrderId && async.data.shopifyStore == event.data.shopifyStore",
      },
    ],
  },
  handleBackorder
);

export const processBackorderRetry = inngest.createFunction(
  {
    id: "process-backorder-retry",
    name: "Process Backorder Manual Retry",
    idempotency: "event.id",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: backorderConcurrency,
    triggers: [{ event: "backorder/retry" }],
  },
  handleBackorder
);
