// ============================================================================
// SHOPIFY ORDER → D365 & GPS SYNC
// ============================================================================
// Processes new Shopify orders (created/paid)
// 1. Validates order (Test, High Risk, Welcome Kit filter, etc.)
// 2. Creates D365 Sales Order
// 3. Creates GPS Outbound Order (if applicable)
// 4. Handles Out of Stock retries

import * as dynamics from "@/lib/clients/dynamics";
import { config } from "@/lib/config";
import { getGpsLogisticsChannelIfApplicable } from "@/lib/helpers/warehouse";
import {
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  TAG_WAIT_DURATION,
  TAG_WAIT_ENABLED,
  THROTTLE_CONFIGS,
} from "@/lib/utils/constants";
import { inngest } from "../client";
import type { RunSequenceStage, ShopifyOrderPayload } from "../events";
import { completeOrderProcessing } from "./process-shopify-order/complete-order";
import { createD365Order } from "./process-shopify-order/d365-order";
import { handleExistingD365Order } from "./process-shopify-order/existing-d365-order";
import { handleOrderProcessingFailure } from "./process-shopify-order/failure-handler";
import { type FulfillmentSplitResult } from "./process-shopify-order/fulfillment-split";
import { processGpsOrder } from "./process-shopify-order/gps-order";
import {
  EMPTY_PAYMENT_ACCOUNTING,
  loadOrderPaymentAccounting,
  type OrderPaymentAccounting,
} from "./process-shopify-order/payment-accounting";
import { prepareShopifyOrder } from "./process-shopify-order/prepare-order";
import { createOrderRealtimePublisher } from "./process-shopify-order/realtime-publisher";
import { createOrderRunSequenceHandoff } from "./process-shopify-order/run-sequence-handoff";
import { loadSaudiShortAddress } from "./process-shopify-order/saudi-short-address";
import type { OrderLinesSupabaseSyncLog, OrderSyncResult } from "./process-shopify-order/types";
import { handleValidationFailure } from "./process-shopify-order/validation-failure";

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",
    name: "Process Shopify Order",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        // Per-country order concurrency is env-tunable via CONCURRENCY_ORDER_PROCESSING.
        limit: CONCURRENCY_CONFIGS.ORDER_PROCESSING.limit,
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
    cancelOn: [{ event: "shopify/order.cancelled", match: "data.shopifyOrderId" }],
    priority: {
      run: "event.data.isSubscription ? 100 : 0",
    },
    triggers: [{ event: "shopify/order.created" }, { event: "shopify/order.paid" }],
  },
  async ({ event, step, publish, runId }: { event: any; step: any; publish: any; runId: any }) => {
    const {
      shopifyOrderId: rawShopifyOrderId,
      shopifyOrderName,
      orderJson,
      shopifyStore,
    } = event.data;
    const isRerun =
      Boolean(event.data.originalShopifyOrderId) ||
      String(rawShopifyOrderId || "").includes("-rerun-");
    // testMode: synthetic orders sent directly to Inngest (no real Shopify order).
    // Skip Shopify refetch; use orderJson from the event directly.
    const isTestMode = Boolean(event.data.testMode);
    // Reruns append "-rerun-<ts>" to shopifyOrderId for idempotency.
    // Always use canonical Shopify order ID for Shopify API calls and persistence.
    const shopifyOrderId = String(
      event.data.originalShopifyOrderId || String(rawShopifyOrderId || "").split("-rerun-")[0]
    );
    // Initial order from webhook - will be refreshed after 5min delay
    let order = orderJson as ShopifyOrderPayload;

    // Inngest IDs for linking to dashboard:
    // - event.id is the idempotency key we passed (e.g., "shopify-order-paid-xxx")
    // - runId is the internal run ID for /runs/ URLs (e.g., "01KGWWR0AKZMSTNYJ6VWJMR7DD")
    const inngestIdempotencyKey = event.id;
    const inngestRunId = runId;

    const _orderProcessingStart = Date.now();

    const { publishStatus, publishResult, stepDurations } = createOrderRealtimePublisher({
      publish,
      shopifyOrderId,
      shopifyOrderName,
      inngestIdempotencyKey,
      inngestRunId,
    });
    const incomingRunSequence = Array.isArray(event.data.runSequence)
      ? (event.data.runSequence as RunSequenceStage[])
      : [];
    const handOffSequencedRunIfAny = createOrderRunSequenceHandoff({
      incomingRunSequence,
      getOrder: () => order,
      shopifyOrderId,
      shopifyOrderName,
      shopifyStore,
      inngestRunId,
      inngestIdempotencyKey,
    });

    // Publish initial status
    await publishStatus("started", "running", "Order processing started");

    if (config.features.dryRunMode) {
      await publishResult("skipped", { error: "Dry run mode enabled" });
      return {
        status: "dry_run",
        shopifyOrderId,
        shopifyOrderName,
      };
    }

    if (isTestMode) {
      // Synthetic test order — use provided orderJson directly, no Shopify API call
      await publishStatus(
        "wait-for-tags",
        "skipped",
        "Test mode: using provided orderJson directly"
      );
      console.log(
        `[Order] Test mode for ${shopifyOrderName} — skipping tag wait and Shopify refetch`
      );
    } else if (isRerun) {
      await publishStatus("wait-for-tags", "skipped", "Rerun: skipping tag wait delay");
      const refreshedOrder = await step.run("refetch-order-rerun-no-delay", async () => {
        const { getOrder } = await import("@/lib/clients/shopify");
        const freshOrder = await getOrder(shopifyOrderId, shopifyStore);
        console.log(
          `[Order] Refetched order ${shopifyOrderName} without delay (rerun). Tags: ${freshOrder.tags || "none"}`
        );
        return freshOrder;
      });
      order = refreshedOrder as ShopifyOrderPayload;
    } else if (!TAG_WAIT_ENABLED) {
      // TAG_WAIT_ENABLED=false via env var — skip delay, still refetch for freshest data
      await publishStatus(
        "wait-for-tags",
        "skipped",
        "Tag wait disabled via TAG_WAIT_ENABLED=false"
      );
      const refreshedOrder = await step.run("refetch-order-no-delay", async () => {
        const { getOrder } = await import("@/lib/clients/shopify");
        const freshOrder = await getOrder(shopifyOrderId, shopifyStore);
        console.log(
          `[Order] Refetched order ${shopifyOrderName} (tag wait disabled). Tags: ${freshOrder.tags || "none"}`
        );
        return freshOrder;
      });
      order = refreshedOrder as ShopifyOrderPayload;
    } else {
      // Normal flow: wait TAG_WAIT_DURATION for Shopify tags to propagate
      await publishStatus(
        "wait-for-tags",
        "running",
        `Waiting ${TAG_WAIT_DURATION} for order tags to be available`
      );
      await step.sleep("wait-for-tags", TAG_WAIT_DURATION as any);

      const refreshedOrder = await step.run("refetch-order-after-delay", async () => {
        const { getOrder } = await import("@/lib/clients/shopify");
        const freshOrder = await getOrder(shopifyOrderId, shopifyStore);
        console.log(
          `[Order] Refetched order ${shopifyOrderName} after ${TAG_WAIT_DURATION} delay. Tags: ${freshOrder.tags || "none"}`
        );
        return freshOrder;
      });
      await publishStatus("wait-for-tags", "completed", "Order refetched with latest tags");
      order = refreshedOrder as ShopifyOrderPayload;
    }

    // If cancellation happened during the tag-wait window, stop before any
    // order creation side effects. cancelOn should terminate most runs, but
    // this guards against race conditions where cancel arrives near wake-up.
    if (order?.cancelled_at) {
      await publishStatus(
        "preflight-cancel-check",
        "skipped",
        `Order was cancelled at ${order.cancelled_at} before processing`
      );
      await publishResult("skipped", {
        error: "Order cancelled before processing started",
      });
      return {
        status: "cancelled_before_processing",
        shopifyOrderId,
        shopifyOrderName,
        cancelledAt: order.cancelled_at,
      };
    }

    const prepareResult = await prepareShopifyOrder({
      step,
      order,
      shopifyOrderId,
      shopifyOrderName,
      publishStatus,
    });

    const validationResult = await handleValidationFailure({
      prepareResult,
      step,
      eventName: String(event.name || "shopify/order.paid"),
      shopifyOrderId,
      shopifyOrderName,
      shopifyStore,
      inngestIdempotencyKey,
      inngestRunId,
      publishStatus,
      publishResult,
    });
    if (validationResult) return validationResult;

    order = prepareResult.updatedOrder as ShopifyOrderPayload;
    const routingResult = prepareResult.routingResult!;
    await publishStatus(
      "prepare-order",
      "completed",
      "Order prepared: SKUs resolved, validated, routing determined"
    );

    const warehouseName = routingResult.warehouseName;
    const dataAreaId = routingResult.dataAreaId;
    const country_code = routingResult.countryCode;
    const gpsLogisticsChannel = getGpsLogisticsChannelIfApplicable(warehouseName, order);
    const saudiShortAddress = await loadSaudiShortAddress({
      step,
      order,
      shopifyOrderId,
      shopifyStore,
    });

    let salesOrderNumber: string | undefined;
    try {
      // D365 calls controlled by ENABLE_DYNAMICS_SYNC
      const skipD365 = !config.features.enableDynamicsSync;

      // MEGA-STEP: D365 create + prepayment + GPS payload + GPS send (single step to minimise checkpoint overhead)
      await publishStatus("create-d365-order", "running", "Syncing paid order to D365 and GPS");
      // ────────────────────────────────────────────────────────────────────
      // Order sync — split into separately checkpointed, idempotent steps.
      // Each external write (D365 header, D365 lines, Supabase persist, D365
      // confirm, D365 prepayment, Shopify FO split, GPS dispatch) is its own
      // step.run so a failure downstream (e.g. GPS) never re-executes writes
      // that already succeeded upstream (e.g. D365 header/lines) on retry —
      // Inngest memoizes each step id independently, unlike a single mega-step.
      // ────────────────────────────────────────────────────────────────────

      // ── Step: check for existing D365 order (idempotency check) ─────────
      await publishStatus("d365.check-existing", "running", "Checking for existing D365 order");
      const existingCheck = await step.run("d365-check-existing", async () => {
        if (skipD365) {
          console.log("[D365] Dynamics sync disabled, skipping order lookup");
          return { exists: false as const };
        }
        console.log(
          `[D365] Looking up existing order for Shopify Name: ${shopifyOrderName} in dataAreaId: ${dataAreaId}`
        );
        const existing = await dynamics.getSalesOrderByShopifyId(
          shopifyOrderName,
          dataAreaId,
          undefined,
          { shopifyNumericId: shopifyOrderId }
        );
        if (existing) {
          return { exists: true as const, salesOrderNumber: existing.SalesOrderNumber };
        }
        return { exists: false as const };
      });

      let syncResult: OrderSyncResult;
      let fulfillmentSplit: FulfillmentSplitResult = {
        applied: false,
        reason: "d365_order_already_existed",
        threshold: null,
        fulfillmentOrders: [],
      };
      let paymentAccounting: OrderPaymentAccounting = EMPTY_PAYMENT_ACCOUNTING;

      if (existingCheck.exists) {
        await publishStatus(
          "d365.check-existing",
          "completed",
          `Existing order found: ${existingCheck.salesOrderNumber}`,
          { d365OrderNumber: existingCheck.salesOrderNumber }
        );
        syncResult = {
          type: "already_exists" as const,
          salesOrderNumber: existingCheck.salesOrderNumber!,
          lineItems: [] as any[],
          d365InventoryLotsBySku: {} as Record<string, string>,
          orderLinesSupabase: {
            attempted: false,
            skipReason: "d365_order_already_existed" as const,
            note: "Reused existing D365 order — this run did not upsert Hub order_lines (lines may be missing until a full sync or backfill).",
          } satisfies OrderLinesSupabaseSyncLog,
          gpsResult: { type: "skipped" as const, reason: "d365_order_already_existed" },
        };
      } else {
        await publishStatus("d365.check-existing", "completed", "No existing order found");

        paymentAccounting = await loadOrderPaymentAccounting({
          step,
          shopifyOrderId,
          shopifyOrderName,
          shopifyStore,
        });

        const { salesOrderNo, lineItems, d365InventoryLotsBySku, orderLinesSupabase } =
          await createD365Order({
            step,
            order,
            shopifyOrderId,
            shopifyOrderName,
            warehouseName,
            dataAreaId,
            skipD365,
            paymentAccounting,
            saudiShortAddress,
            publishStatus,
          });

        const gpsProcessing = await processGpsOrder({
          step,
          order,
          shopifyOrderId,
          shopifyOrderName,
          salesOrderNo,
          warehouseName,
          destinationCountryCode: country_code,
          saudiShortAddress,
          publishStatus,
        });
        const gpsResult = gpsProcessing.gpsResult;
        fulfillmentSplit = gpsProcessing.fulfillmentSplit;

        syncResult = {
          type: "sync_complete" as const,
          salesOrderNumber: salesOrderNo,
          lineItems,
          d365InventoryLotsBySku,
          orderLinesSupabase,
          gpsResult,
        };
      }

      const existingOrderResult = await handleExistingD365Order({
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
      });
      if (existingOrderResult) return existingOrderResult;

      salesOrderNumber = syncResult.salesOrderNumber;
      return completeOrderProcessing({
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
        saudiShortAddress,
        inngestIdempotencyKey,
        inngestRunId,
        orderProcessingStart: _orderProcessingStart,
        stepDurations,
        publishStatus,
        publishResult,
        handOffSequencedRunIfAny,
      });
    } catch (error) {
      return handleOrderProcessingFailure({
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
      });
    }
  }
);
