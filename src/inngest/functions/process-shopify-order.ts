// ============================================================================
// SHOPIFY ORDER → D365 & GPS SYNC
// ============================================================================
// Processes new Shopify orders (created/paid)
// 1. Validates order (Test, High Risk, Welcome Kit filter, etc.)
// 2. Creates D365 Sales Order
// 3. Creates GPS Outbound Order (if applicable)
// 4. Handles Out of Stock retries

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import {
  getVariantSkusByVariantIds,
  setGpsOrderMetafield,
  shopifyAdminGraphql,
} from "@/lib/clients/shopify";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toOrderLineRecords,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
} from "@/lib/transformers/order";
import {
  saveOrderLines,
  updateOrderLineLotId,
  type OrderLineRecord,
  type SaveOrderLinesResult,
} from "@/lib/services/supabase-order-lines";

/** Shown on `sync-order` step output + supabase.order-lines flow log */
type OrderLinesSupabaseSyncLog = {
  attempted: boolean;
  skipReason?: "d365_order_already_existed" | "dynamics_sync_disabled";
  note?: string;
  d365LineCount?: number;
  recordsPrepared?: number;
  skippedD365ServiceLines?: number;
  save?: SaveOrderLinesResult;
  preview?: Array<{
    shopify_line_item_id: string;
    d365_item_number: string;
    hasLotId: boolean;
  }>;
};
import { type WarehouseName } from "@/lib/helpers/warehouse";
import { validateOrderCompletely } from "@/lib/utils/validation";
import {
  getDataAreaIdForLocationAndCountry,
  getLocationRoutingDebugContext,
  getWarehouseNameForLocation,
  findLocationByWarehouseName,
  resolveStordHubWhenFulfillmentLocationUnmapped,
} from "@/lib/services/location-routing";
import { determineWarehouse, isGpsUkWarehouse } from "@/lib/helpers/warehouse";
import { shouldSplitFulfillmentOrder, isDomesticOrder } from "@/lib/helpers/split";
import { getFulfillmentOrders } from "@/lib/clients/shopify";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  retryWithBackoff,
  TAG_WAIT_ENABLED,
  TAG_WAIT_DURATION,
} from "@/lib/utils/constants";
import { CancelReasonEnum, type ShopifyOrderPayload } from "../events";
import { orderChannel } from "../channels";
import { SlackChannelEnum } from "@/lib/types/slack";
import { NonRetriableError } from "inngest";
import { logFlowEvent, flushAll as flushFlowLogs } from "@/lib/services/supabase-flow-logs";

function selectPreferredFulfillmentLocationId(fulfillmentOrders: any[]): number | null {
  const activeOrders = fulfillmentOrders.filter(
    (fo: any) => fo?.status === "open" || fo?.status === "in_progress"
  );
  if (!activeOrders.length) return null;

  // Priority 1: open FOs with a real delivery method AND a non-virtual location
  const deliverable = activeOrders.filter((fo: any) => {
    const methodType = String(fo?.delivery_method?.method_type || "").toLowerCase();
    const assignedLocationName = String(fo?.assigned_location?.name || "").toLowerCase();
    return methodType !== "none" && !assignedLocationName.includes("virtual");
  });
  if (deliverable[0]?.assigned_location_id) {
    return Number(deliverable[0].assigned_location_id);
  }

  // Priority 2: any open FO whose assigned location is not virtual (ignoring delivery method)
  const nonVirtual = activeOrders.filter(
    (fo: any) =>
      !String(fo?.assigned_location?.name || "")
        .toLowerCase()
        .includes("virtual")
  );
  if (nonVirtual[0]?.assigned_location_id) {
    return Number(nonVirtual[0].assigned_location_id);
  }

  // All open FOs point to virtual — return null so caller can use intended_location_id
  return null;
}

function getIntendedLocationIdFromOrder(order: ShopifyOrderPayload): number | null {
  const attributes = Array.isArray((order as any)?.note_attributes)
    ? ((order as any).note_attributes as Array<{ name?: string; value?: string }>)
    : [];

  const getAttr = (key: string) =>
    attributes.find((a) => String(a?.name || "").toLowerCase() === key)?.value || "";

  const intendedName = getAttr("intended_location_name");
  // Skip if the noted intended location is itself virtual — it was created incorrectly
  if (intendedName && String(intendedName).toLowerCase().includes("virtual")) {
    return null;
  }

  const intendedId = getAttr("intended_location_id");
  const parsed = Number(String(intendedId).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isInventoryIssueError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("out of stock") ||
    m.includes("inventory insufficient") ||
    m.includes("cannot be reserved") ||
    (m.includes("item number") && m.includes("does not exist")) ||
    m.includes("库存不足") ||
    m.includes("未维护新品") ||
    m.includes("sku有误") ||
    m.includes("未通过审核")
  );
}

function isNonRetryableOrderError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    // Inventory / master-data conditions that won't be fixed by immediate retries
    m.includes("out of stock") ||
    m.includes("inventory insufficient") ||
    m.includes("cannot be reserved") ||
    (m.includes("item number") && m.includes("does not exist")) ||
    m.includes("sku有误") ||
    m.includes("未维护新品") ||
    m.includes("未通过审核") ||
    // Warehouse/configuration issues
    m.includes("unknown warehouse") ||
    m.includes("unsupported warehouse") ||
    m.includes("unsupported virtual warehouse") ||
    m.includes("not fully configured in battle hub") ||
    // Malformed line payloads / missing SKU should fail fast (not retried)
    m.includes("item or category must be specified") ||
    m.includes("missing sku/itemnumber") ||
    m.includes("missing d365 itemnumber") ||
    // D365 number sequence exhausted requires manual fix in D365.
    isD365NumberSequenceExceededError(m)
  );
}

function inferInventoryErrorType(message: string): string {
  const m = String(message || "").toLowerCase();
  if (m.includes("item number") && m.includes("does not exist")) {
    return "d365_item_not_found";
  }
  if (m.includes("cannot be reserved") || m.includes("inventory insufficient")) {
    return "inventory_insufficient";
  }
  if (m.includes("未维护新品")) {
    return "unmaintained_product";
  }
  if (m.includes("sku有误") || m.includes("未通过审核")) {
    return "unmaintained_product";
  }
  return "out_of_stock";
}

function isServiceSkuItemNumber(itemNumber?: string | null): boolean {
  const sku = String(itemNumber || "").toUpperCase();
  return sku.startsWith("IM8-SER-") || sku.startsWith("PRE-SER-");
}

function isD365ItemNotFoundError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return m.includes("item number") && m.includes("does not exist");
}

function isD365NumberSequenceExceededError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return m.includes("number sequence") && m.includes("has been exceeded");
}

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
    const ch = orderChannel({ orderName: shopifyOrderName });
    /** Inngest Realtime `publish` is only injected when the run opts into channels; guard to avoid TypeError. */
    const publishToRealtime = async (channel: unknown, payload: Record<string, unknown>) => {
      if (typeof publish !== "function") return;
      await publish(channel, payload);
    };
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

    // Track step start times and completed durations for timing summary
    const stepStartTimes = new Map<string, number>();
    const stepDurations: Array<{ step: string; durationMs: number }> = [];

    // Helper to publish status updates via Inngest Realtime
    const publishStatus = async (
      stepName: string,
      status: "running" | "completed" | "failed" | "skipped",
      message?: string,
      data?: Record<string, unknown>
    ) => {
      const now = Date.now();
      let durationMs: number | undefined;

      // Track timing
      if (status === "running") {
        stepStartTimes.set(stepName, now);
      } else if (status === "completed" || status === "failed") {
        const startTime = stepStartTimes.get(stepName);
        if (startTime) {
          durationMs = now - startTime;
          stepStartTimes.delete(stepName);
          stepDurations.push({ step: stepName, durationMs });
        }
      }

      try {
        logFlowEvent({
          level: status === "failed" ? "error" : status === "skipped" ? "warn" : "info",
          flow: "order_paid",
          step: stepName,
          runId: inngestRunId,
          shopifyOrderId,
          shopifyOrderName,
          status,
          durationMs,
          errorMessage: status === "failed" ? message : undefined,
          payload: data,
        });
        await publishToRealtime(ch.status, {
          orderName: shopifyOrderName,
          inngestIdempotencyKey,
          inngestRunId,
          step: stepName,
          status,
          message,
          data,
          durationMs,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        // Don't fail the function if realtime publish fails
        console.warn(`[Realtime] Failed to publish status: ${err}`);
      }
    };

    // Helper to publish final result
    const publishResult = async (
      status: "success" | "failed" | "skipped",
      resultData?: {
        d365OrderNumber?: string;
        gpsOrderNo?: string;
        warehouse?: string;
        error?: string;
      }
    ) => {
      try {
        logFlowEvent({
          level: status === "failed" ? "error" : status === "skipped" ? "warn" : "info",
          flow: "order_paid",
          step: "result",
          runId: inngestRunId,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: resultData?.d365OrderNumber,
          status,
          errorMessage: resultData?.error,
          payload: resultData,
        });
        await publishToRealtime(ch.result, {
          orderName: shopifyOrderName,
          inngestIdempotencyKey,
          inngestRunId,
          status,
          ...resultData,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[Realtime] Failed to publish result: ${err}`);
      }
    };

    // ────────────────────────────────────────────────────────────────────────
    // Sequenced rerun hand-off: when this run was dispatched as part of a
    // multi-stage rerun (state.runSequence), `event.data.runSequence` carries
    // the remaining stages to execute after this one. We dispatch the next
    // stage on success and persist progress to orders.state.runSequence.
    // ────────────────────────────────────────────────────────────────────────
    const incomingRunSequence: import("../events").RunSequenceStage[] = Array.isArray(
      event.data.runSequence
    )
      ? (event.data.runSequence as import("../events").RunSequenceStage[])
      : [];
    const handOffSequencedRunIfAny = async (resultPayload: Record<string, unknown>) => {
      if (incomingRunSequence.length === 0) return;
      try {
        const { advanceRunSequence } = await import("@/lib/services/run-sequence");
        await advanceRunSequence({
          shopifyOrderId,
          shopifyOrderName,
          completedStage: {
            id: `order_creation-${inngestRunId}`,
            stage: "order_creation",
            eventName: "shopify/order.paid",
            status: "completed",
            runId: inngestRunId,
          },
          remaining: incomingRunSequence,
          orderJson: order,
          fulfillments: Array.isArray((order as any)?.fulfillments)
            ? ((order as any).fulfillments as any[])
            : [],
          shopifyStore,
          inngestRunId,
          inngestIdempotencyKey,
        });
        logFlowEvent({
          flow: "order_paid",
          step: "sequenced-handoff",
          status: "completed",
          runId: inngestRunId,
          shopifyOrderId,
          shopifyOrderName,
          payload: { ...resultPayload, nextStage: incomingRunSequence[0]?.stage },
        });
      } catch (err) {
        console.warn(
          `[RunSequence] Failed to advance after order_creation for ${shopifyOrderName}: ${err}`
        );
      }
    };

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

    await publishStatus(
      "prepare-order",
      "running",
      "Resolving SKUs, validating order, and determining warehouse routing"
    );
    const prepareResult = await step.run("prepare-order", async () => {
      // --- 1. Resolve missing line SKUs ---
      let currentOrder = order;
      const lineItems = Array.isArray(currentOrder?.line_items) ? currentOrder.line_items : [];
      const missingShippableLines = lineItems
        .map((item: any, index: number) => ({ item, index }))
        .filter(({ item }) => {
          const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
          const requiresShipping = item?.requires_shipping !== false;
          return requiresShipping && !sku;
        });

      let skuResolution: {
        attempted: number;
        resolved: number;
        unresolved: Array<{ index: number; title: string; variantId: number | null }>;
      };

      if (missingShippableLines.length === 0) {
        skuResolution = { attempted: 0, resolved: 0, unresolved: [] };
      } else {
        const variantIds = missingShippableLines
          .map(({ item }) => Number(item?.variant_id))
          .filter((id) => Number.isFinite(id) && id > 0);

        const latestSkuByVariantId =
          variantIds.length > 0 ? await getVariantSkusByVariantIds(variantIds) : {};

        let resolved = 0;
        const patchedLineItems = lineItems.map((item: any) => {
          const currentSku = typeof item?.sku === "string" ? item.sku.trim() : "";
          const requiresShipping = item?.requires_shipping !== false;
          if (!requiresShipping || currentSku) return item;

          const variantId = Number(item?.variant_id);
          const latestSku =
            Number.isFinite(variantId) && variantId > 0
              ? latestSkuByVariantId[String(Math.trunc(variantId))]
              : "";
          if (!latestSku) return item;
          resolved += 1;
          return { ...item, sku: latestSku };
        });

        const unresolved = patchedLineItems
          .map((item: any, index: number) => ({ item, index }))
          .filter(({ item }) => {
            const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
            const requiresShipping = item?.requires_shipping !== false;
            return requiresShipping && !sku;
          })
          .map(({ item, index }) => ({
            index,
            title: item?.title || "untitled",
            variantId:
              Number.isFinite(Number(item?.variant_id)) && Number(item?.variant_id) > 0
                ? Number(item?.variant_id)
                : null,
          }));

        currentOrder = { ...currentOrder, line_items: patchedLineItems } as ShopifyOrderPayload;
        skuResolution = { attempted: missingShippableLines.length, resolved, unresolved };
      }

      // --- Handle unresolved SKUs ---
      if (skuResolution.unresolved.length > 0) {
        const lineItemsAfterPatch = Array.isArray(currentOrder?.line_items)
          ? currentOrder.line_items
          : [];
        const unresolvedIdx = new Set(
          skuResolution.unresolved.map((u: { index: number }) => u.index)
        );
        const filteredLineItems = lineItemsAfterPatch.filter((_, idx) => !unresolvedIdx.has(idx));

        const hasShippableWithSku = filteredLineItems.some((item: any) => {
          const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
          const requiresShipping = item?.requires_shipping !== false;
          return requiresShipping && !!sku;
        });

        const unresolvedSummary = skuResolution.unresolved
          .slice(0, 5)
          .map(
            (l: { index: number; title: string; variantId: number | null }) =>
              `${l.title} (line=${l.index}, variant=${l.variantId ?? "n/a"})`
          )
          .join(", ");

        if (!hasShippableWithSku) {
          await publishStatus(
            "resolve-line-skus",
            "failed",
            `Unable to resolve SKU for ${skuResolution.unresolved.length} shippable line(s)`
          );
          throw new Error(
            `[D365] Missing SKU/ItemNumber after Shopify variant refresh for ${shopifyOrderName}; ` +
              `attempted=${skuResolution.attempted}; resolved=${skuResolution.resolved}; ` +
              `unresolved=${skuResolution.unresolved.length}; sample=${unresolvedSummary}`
          );
        }

        console.warn(
          `[Order] Excluding ${skuResolution.unresolved.length} shippable line(s) with no SKU in Shopify ` +
            `(GraphQL variant has empty SKU). Remaining lines go to D365/GPS. Sample: ${unresolvedSummary}`
        );
        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `Order ${shopifyOrderName}: excluded ${skuResolution.unresolved.length} shippable line(s) without ItemNumber in Shopify — processing remaining SKUs only. Sample: ${unresolvedSummary}`
        );

        currentOrder = { ...currentOrder, line_items: filteredLineItems } as ShopifyOrderPayload;
        await publishStatus(
          "resolve-line-skus",
          "completed",
          skuResolution.resolved > 0
            ? `Resolved ${skuResolution.resolved} line(s); excluded ${skuResolution.unresolved.length} unresolvable line(s)`
            : `Excluded ${skuResolution.unresolved.length} shippable line(s) with empty variant SKU; remaining lines proceed`
        );
      } else {
        await publishStatus(
          "resolve-line-skus",
          "completed",
          skuResolution.resolved > 0
            ? `Resolved ${skuResolution.resolved} missing SKU line(s) from Shopify variants`
            : "No missing shippable SKUs found"
        );
      }

      // --- 2. Validate order ---
      await publishStatus("validate-order", "running", "Validating order");
      const validation = await validateOrderCompletely(
        currentOrder,
        shopifyOrderId,
        shopifyOrderName
      );

      if (!validation.valid || validation.skip) {
        return { type: "validation_failed" as const, validation, updatedOrder: currentOrder };
      }

      await publishStatus("validate-order", "completed", "Order validation passed");

      // --- 3. Determine warehouse routing ---
      const countryCode =
        currentOrder.shipping_address?.country_code ||
        currentOrder.billing_address?.country_code ||
        "US";

      const intendedLocationId = getIntendedLocationIdFromOrder(currentOrder);

      let fulfillmentLocationId: number | null = null;
      try {
        const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
        fulfillmentLocationId = selectPreferredFulfillmentLocationId(fulfillmentOrders as any[]);
      } catch (error) {
        console.warn(`[Order Routing] Could not fetch fulfillment orders: ${error}`);
      }

      if (!fulfillmentLocationId && intendedLocationId) {
        fulfillmentLocationId = intendedLocationId;
        console.log(
          `[Order Routing] Using intended_location_id=${intendedLocationId} from order note attributes for ${shopifyOrderName}`
        );
      }

      if (!fulfillmentLocationId) {
        const expectedWarehouseName = determineWarehouse(countryCode);
        const hubLocation = await findLocationByWarehouseName(expectedWarehouseName, "im8");
        if (hubLocation?.shopifyLocationId) {
          fulfillmentLocationId = Number(hubLocation.shopifyLocationId);
          console.warn(
            `[Order Routing] ${shopifyOrderName}: Shopify only assigned a virtual location. ` +
              `Resolved to "${expectedWarehouseName}" (id=${fulfillmentLocationId}) via country=${countryCode} + Battle Hub config.`
          );
        } else {
          throw new Error(
            `[Order Routing] No Shopify fulfillment location assigned for ${shopifyOrderName} and no Battle Hub location is configured for country=${countryCode} (expected warehouse: ${expectedWarehouseName}). ` +
              `Configure the location in Battle Hub Locations settings.`
          );
        }
      }

      let locationDataAreaId = await getDataAreaIdForLocationAndCountry(
        fulfillmentLocationId,
        countryCode,
        "im8"
      );
      let warehouseNameFromLocation = await getWarehouseNameForLocation(
        fulfillmentLocationId,
        "im8"
      );

      if (
        intendedLocationId &&
        intendedLocationId !== fulfillmentLocationId &&
        String(warehouseNameFromLocation || "")
          .toLowerCase()
          .includes("virtual")
      ) {
        const intendedWarehouse = await getWarehouseNameForLocation(intendedLocationId, "im8");
        if (intendedWarehouse && !String(intendedWarehouse).toLowerCase().includes("virtual")) {
          fulfillmentLocationId = intendedLocationId;
          locationDataAreaId = await getDataAreaIdForLocationAndCountry(
            fulfillmentLocationId,
            countryCode,
            "im8"
          );
          warehouseNameFromLocation = intendedWarehouse;
          console.log(
            `[Order Routing] Switched from virtual location to intended_location_id=${intendedLocationId} for ${shopifyOrderName}`
          );
        }
      }

      if (!locationDataAreaId || !warehouseNameFromLocation) {
        const stordHub = await resolveStordHubWhenFulfillmentLocationUnmapped(
          currentOrder,
          countryCode,
          "im8"
        );
        if (stordHub) {
          const unknownLoc = fulfillmentLocationId;
          locationDataAreaId = stordHub.dataAreaId;
          warehouseNameFromLocation = stordHub.warehouseName;
          fulfillmentLocationId = Number(stordHub.hubShopifyLocationId);
          console.warn(
            `[Order Routing] ${shopifyOrderName}: fulfillment location ${unknownLoc} is not in Battle Hub; ` +
              `all lines use fulfillment_service=stord — using configured "${stordHub.warehouseName}" ` +
              `(hub Shopify location id ${stordHub.hubShopifyLocationId}). ` +
              `Add or update this location in Battle Hub (shopify_location_id=${unknownLoc}) so routing stays explicit.`
          );
        }
      }

      if (!locationDataAreaId || !warehouseNameFromLocation) {
        const routingContext = await getLocationRoutingDebugContext(
          fulfillmentLocationId,
          countryCode,
          "im8"
        );
        throw new Error(
          `[Order Routing] Shopify location ${fulfillmentLocationId} is not fully configured in Battle Hub for country ${countryCode}. Set the location warehouse name and dataAreaId/country override in Locations; country fallback is disabled. Context: ${routingContext}`
        );
      }

      if (String(warehouseNameFromLocation).toLowerCase().includes("virtual")) {
        const routingContext = await getLocationRoutingDebugContext(
          fulfillmentLocationId,
          countryCode,
          "im8"
        );
        throw new Error(
          `[Order Routing] Unsupported virtual warehouse "${warehouseNameFromLocation}" for Shopify location ${fulfillmentLocationId}. Configure a real fulfillment location in Shopify and Battle Hub. Context: ${routingContext}`
        );
      }

      console.log(
        `[Order Routing] Location ${fulfillmentLocationId} + country ${countryCode} → warehouse: ${warehouseNameFromLocation}, dataAreaId: ${locationDataAreaId}`
      );

      return {
        type: "ready" as const,
        validation,
        updatedOrder: currentOrder,
        routingResult: {
          warehouseName: warehouseNameFromLocation as WarehouseName,
          dataAreaId: locationDataAreaId,
          countryCode,
          routingSource: "location" as const,
        },
      };
    });

    // Handle validation failures (returned from within the consolidated step)
    if (prepareResult.type === "validation_failed") {
      const validation = prepareResult.validation;
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

    let salesOrderNumber: string | undefined;
    /** Captured from D365 line create responses — persisted on Hub `orders.state` for fulfillment Lotid fallback. */
    let d365InventoryLotsBySku: Record<string, string> = {};
    try {
      // D365 calls controlled by ENABLE_DYNAMICS_SYNC
      const skipD365 = !config.features.enableDynamicsSync;

      // MEGA-STEP: D365 create + prepayment + GPS payload + GPS send (single step to minimise checkpoint overhead)
      await publishStatus("create-d365-order", "running", "Syncing paid order to D365 and GPS");
      const syncResult = await step.run("sync-order", async () => {
        // Check for existing D365 order (idempotency check)
        await publishStatus("d365.check-existing", "running", "Checking for existing D365 order");
        if (skipD365) {
          console.log("[D365] Dynamics sync disabled, skipping order lookup");
        } else {
          console.log(
            `[D365] Looking up existing order for Shopify Name: ${shopifyOrderName} in dataAreaId: ${dataAreaId}`
          );
          const existing = await dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
          if (existing) {
            await publishStatus(
              "d365.check-existing",
              "completed",
              `Existing order found: ${existing.SalesOrderNumber}`,
              { d365OrderNumber: existing.SalesOrderNumber }
            );
            return {
              type: "already_exists" as const,
              salesOrderNumber: existing.SalesOrderNumber,
              lineItems: [] as any[],
              d365InventoryLotsBySku: {} as Record<string, string>,
              orderLinesSupabase: {
                attempted: false,
                skipReason: "d365_order_already_existed" as const,
                note: "Reused existing D365 order — this run did not upsert Hub order_lines (lines may be missing until a full sync or backfill).",
              } satisfies OrderLinesSupabaseSyncLog,
            };
          }
        }
        await publishStatus("d365.check-existing", "completed", "No existing order found");

        // Create D365 Header
        await publishStatus("d365.create-header", "running", "Creating D365 sales order header");
        const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId);
        let d365Header;
        if (skipD365) {
          d365Header = { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: headerRequest };
        } else {
          d365Header = await retryWithBackoff(
            () => dynamics.createSalesOrderHeaderV3(headerRequest),
            {
              label: `D365 header ${shopifyOrderName}`,
            }
          );
        }

        const salesOrderNo = d365Header.SalesOrderNumber;
        if (!salesOrderNo) {
          throw new Error(`[D365] Missing SalesOrderNumber for ${shopifyOrderName}`);
        }
        await publishStatus("d365.create-header", "completed", `Header created: ${salesOrderNo}`, {
          d365OrderNumber: salesOrderNo,
        });

        // Create D365 Lines - parallel creation
        const lineItems = toD365SalesOrderLines(
          order,
          salesOrderNo,
          warehouseName,
          true,
          dataAreaId
        );
        lineItems.forEach((item) => {
          item.dataAreaId = dataAreaId;
        });
        await publishStatus(
          "d365.create-lines",
          "running",
          `Creating ${lineItems.length} line items`,
          { totalLines: lineItems.length }
        );

        let d365InventoryLotsBySku: Record<string, string> = {};
        let orderLinesSupabase: OrderLinesSupabaseSyncLog;

        if (skipD365) {
          orderLinesSupabase = {
            attempted: false,
            skipReason: "dynamics_sync_disabled",
            d365LineCount: lineItems.length,
            note: "ENABLE_DYNAMICS_SYNC off — order_lines upsert skipped",
          };
        } else {
          const invalidLines = lineItems
            .map((line, index) => ({ line, index }))
            .filter(
              ({ line }) =>
                typeof line.itemNumber !== "string" ||
                line.itemNumber.trim().length === 0 ||
                !Number.isFinite(line.quantity) ||
                line.quantity <= 0
            );
          if (invalidLines.length > 0) {
            const details = invalidLines.slice(0, 5).map(({ line, index }) => ({
              index,
              itemNumber: line.itemNumber,
              quantity: line.quantity,
              price: line.price,
            }));
            throw new Error(
              `[D365] Missing SKU/ItemNumber in create-d365-lines for ${shopifyOrderName} (${salesOrderNo}); ` +
                `invalidLines=${invalidLines.length}; details=${JSON.stringify(details)} ` +
                `(missing SKU/ItemNumber is non-retryable)`
            );
          }

          const lineResults = await Promise.all(
            lineItems.map((line) =>
              (async () => {
                try {
                  const created = await retryWithBackoff(
                    () =>
                      dynamics.createSalesOrderLine({ ...line, salesOrderNumber: salesOrderNo }),
                    {
                      label: `D365 line ${line.itemNumber}`,
                      shouldRetry: (err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        return !isNonRetryableOrderError(msg);
                      },
                    }
                  );
                  const lot = created?.InventoryLotId ? String(created.InventoryLotId).trim() : "";
                  return {
                    skipped: false as const,
                    itemNumber: line.itemNumber,
                    inventoryLotId: lot,
                  };
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (isServiceSkuItemNumber(line.itemNumber) && isD365ItemNotFoundError(msg)) {
                    console.warn(
                      `[D365] Skipping missing service SKU line ${line.itemNumber} for ${salesOrderNo}: ${msg}`
                    );
                    return {
                      skipped: true as const,
                      itemNumber: line.itemNumber,
                      error: msg,
                    };
                  }
                  throw err;
                }
              })()
            )
          );
          const skippedServiceLines = lineResults.filter((r) => r.skipped);
          if (skippedServiceLines.length > 0) {
            await publishStatus(
              "d365.create-lines",
              "running",
              `Skipped ${skippedServiceLines.length} missing service SKU lines`,
              {
                skippedServiceSkus: skippedServiceLines.map((s) => s.itemNumber),
                skippedCount: skippedServiceLines.length,
              }
            );
          }
          for (const r of lineResults) {
            if (r.skipped) continue;
            const sku = String(r.itemNumber || "")
              .trim()
              .toUpperCase();
            const lot = "inventoryLotId" in r ? String(r.inventoryLotId || "").trim() : "";
            if (sku && lot) {
              d365InventoryLotsBySku[sku] = lot;
            }
          }
          if (Object.keys(d365InventoryLotsBySku).length > 0) {
            console.log(
              `[D365] Captured InventoryLotId per SKU for ${salesOrderNo}:`,
              d365InventoryLotsBySku
            );
          }

          // Build set of D365 item numbers that were skipped (SKU not released in D365).
          // Do NOT save those to order_lines — they can't be fulfilled.
          const skippedItemNumbers = new Set(
            lineResults.filter((r) => r.skipped).map((r) => r.itemNumber.toUpperCase())
          );

          // Persist all order lines (product + service) to Supabase so fulfillment
          // can replay shipping/tax lines to Dynamics. Lot IDs come from D365's
          // createSalesOrderLine response, captured above in d365InventoryLotsBySku.
          const lineRecords: OrderLineRecord[] = toOrderLineRecords(
            order,
            salesOrderNo,
            warehouseName,
            dataAreaId
          )
            .filter((r) => !skippedItemNumbers.has(r.d365ItemNumber.toUpperCase()))
            .map((r) => ({
              shopify_order_id: String(shopifyOrderId),
              shopify_order_name: shopifyOrderName || order.name,
              shopify_line_item_id: r.shopifyLineItemId,
              shopify_sku: r.shopifySku,
              d365_item_number: r.d365ItemNumber,
              d365_sales_order_number: salesOrderNo,
              data_area_id: dataAreaId,
              quantity: r.quantity,
              price: r.price,
              // Lot ID from D365 createSalesOrderLine response — used at fulfillment time
              dynamics_inventory_lot_id:
                d365InventoryLotsBySku[r.d365ItemNumber.toUpperCase()] ?? null,
              is_service_line: r.isServiceLine,
            }));
          const saveResult = await saveOrderLines(lineRecords);
          orderLinesSupabase = {
            attempted: true,
            d365LineCount: lineItems.length,
            recordsPrepared: lineRecords.length,
            skippedD365ServiceLines: skippedItemNumbers.size,
            save: saveResult,
            preview: lineRecords.slice(0, 12).map((r) => ({
              shopify_line_item_id: r.shopify_line_item_id,
              d365_item_number: r.d365_item_number,
              hasLotId: !!r.dynamics_inventory_lot_id,
            })),
          };

          const flowStatus: "completed" | "failed" | "skipped" = saveResult.ok
            ? "completed"
            : saveResult.reason === "supabase_error"
              ? "failed"
              : "skipped";
          const flowMessage = saveResult.ok
            ? `Upserted ${saveResult.upsertedRowCount} row(s) to public.order_lines`
            : saveResult.reason === "no_supabase_client"
              ? "Skipped: Supabase not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Battle Bus)"
              : saveResult.reason === "empty_input"
                ? "Skipped: toOrderLineRecords returned 0 rows (nothing to persist)"
                : `Supabase upsert failed: ${saveResult.message}`;

          await publishStatus("supabase.order-lines", flowStatus, flowMessage, {
            saveResult,
            recordsPrepared: lineRecords.length,
            d365LinesCreated: lineItems.length,
            shopifyOrderId: String(shopifyOrderId),
            shopifyOrderName,
            salesOrderNumber: salesOrderNo,
            preview: orderLinesSupabase.preview,
          });
        }

        await publishStatus(
          "d365.create-lines",
          "completed",
          `Created ${lineItems.length} line items`,
          { totalLines: lineItems.length }
        );

        // Confirm D365 Order with exponential backoff
        await publishStatus("d365.confirm-order", "running", "Confirming D365 sales order");
        if (!skipD365) {
          const backoffMs = [500, 1000, 2000];

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await dynamics.confirmSalesOrder(salesOrderNo, dataAreaId);
              if (attempt > 1) {
                await publishStatus(
                  "d365.confirm-order",
                  "running",
                  `Confirmed on attempt ${attempt}`,
                  { attempt }
                );
              }
              break;
            } catch (error) {
              const isNotFoundError =
                error instanceof Error && error.message.includes("does not exist");
              if (isNotFoundError && attempt < 3) {
                const waitMs = backoffMs[attempt - 1];
                await publishStatus(
                  "d365.confirm-order",
                  "running",
                  `Waiting ${waitMs}ms for D365 propagation (attempt ${attempt}/3)`,
                  { attempt, maxAttempts: 3, waitMs }
                );
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              } else {
                throw error;
              }
            }
          }
        }
        await publishStatus("d365.confirm-order", "completed", "D365 order confirmed");

        await publishStatus(
          "create-d365-order",
          "completed",
          `D365 order created: ${salesOrderNo}`,
          { d365OrderNumber: salesOrderNo }
        );

        // --- Prepayment (non-blocking) ---
        const prepaymentAmount = calculatePrepaymentAmount(order);
        let prepaymentResult: { success: boolean; amount: number; error?: string } = {
          success: true,
          amount: prepaymentAmount,
        };

        if (!skipD365 && prepaymentAmount > 0) {
          await publishStatus(
            "d365.create-prepayment",
            "running",
            `Creating prepayment: $${prepaymentAmount.toFixed(2)}`,
            { amount: prepaymentAmount }
          );
          try {
            await dynamics.createPrepayment(salesOrderNo, dataAreaId);
            await publishStatus(
              "d365.create-prepayment",
              "completed",
              `Prepayment created: $${prepaymentAmount.toFixed(2)}`,
              { amount: prepaymentAmount }
            );
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isNumberSequenceError =
              errorMessage.includes("Number sequence") &&
              errorMessage.includes("has been exceeded");

            await publishStatus(
              "d365.create-prepayment",
              "skipped",
              `Prepayment ${isNumberSequenceError ? "skipped: D365 number sequence exceeded" : `failed: ${errorMessage}`}. Order will continue without prepayment.`,
              {
                amount: prepaymentAmount,
                error: isNumberSequenceError ? "number_sequence_exceeded" : errorMessage,
                salesOrderNumber: salesOrderNo,
              }
            );

            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              isNumberSequenceError
                ? `⚠️ [D365] Number sequence exceeded for prepayment\nOrder: ${shopifyOrderName} (${salesOrderNo})\nError: ${errorMessage}\nAction Required: Extend number sequence U001-JBN in D365`
                : `⚠️ [D365] Prepayment creation failed for ${shopifyOrderName} (${salesOrderNo}): ${errorMessage}`
            );

            prepaymentResult = {
              success: false,
              amount: prepaymentAmount,
              error: isNumberSequenceError ? "number_sequence_exceeded" : errorMessage,
            };
          }
        }

        // --- Build GPS payload ---
        await publishStatus("gps.build-payload", "running", "Transforming order to GPS format");
        const shouldSendToRealGps =
          shouldSendToGps(order, warehouseName) && config.features.enableGpsSync;
        let gpsOrderPayload: ReturnType<typeof toGpsOutboundOrder> | null = null;
        try {
          gpsOrderPayload = toGpsOutboundOrder(order, salesOrderNo, warehouseName);
          const itemCount = gpsOrderPayload?.productList?.length || 0;
          await publishStatus(
            "gps.build-payload",
            "completed",
            `Payload built with ${itemCount} items`,
            {
              itemCount,
              warehouse: warehouseName,
            }
          );
        } catch (error) {
          await slack.sendWarningMessage(
            "gps",
            `Failed to build GPS payload for ${shopifyOrderName}: ${error}`
          );
          await publishStatus("gps.build-payload", "skipped", "No GPS payload required");
        }

        // --- Fulfillment order splitting (optional, non-blocking) ---
        await publishStatus("send-to-gps", "running", "Preparing GPS warehouse order");
        try {
          const orderTotal = parseFloat(order.total_price || "0");
          const countryCode = country_code || "US";
          const domestic = isDomesticOrder(countryCode);
          const splitDecision = shouldSplitFulfillmentOrder(orderTotal, countryCode, domestic);

          console.log(
            `[Fulfillment Split] ${shopifyOrderName}: ${splitDecision.reason} ` +
              `(total=${orderTotal}, threshold=${splitDecision.threshold}, country=${countryCode})`
          );

          if (splitDecision.shouldSplit) {
            const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
            const openFO = fulfillmentOrders?.find(
              (fo: any) => fo?.status === "open" || fo?.status === "in_progress"
            );

            if (!openFO) {
              console.warn(
                `[Fulfillment Split] No open fulfillment order found for ${shopifyOrderName}`
              );
            } else {
              const fulfillmentOrderGid = `gid://shopify/FulfillmentOrder/${openFO.id}`;
              const foLineItems = (openFO as any).line_items || [];

              if (foLineItems.length < 2) {
                console.log(
                  `[Fulfillment Split] Only ${foLineItems.length} line item(s), cannot split`
                );
              } else {
                const midpoint = Math.ceil(foLineItems.length / 2);
                const splitLineItems = foLineItems.slice(midpoint).map((li: any) => ({
                  fulfillmentOrderLineItemId: `gid://shopify/FulfillmentOrderLineItem/${li.id}`,
                  quantity: li.quantity || li.fulfillable_quantity || 1,
                }));

                const mutation = `
                  mutation fulfillmentOrderSplit($fulfillmentOrderId: ID!, $fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!) {
                    fulfillmentOrderSplit(fulfillmentOrderId: $fulfillmentOrderId, fulfillmentOrderSplits: $fulfillmentOrderSplits) {
                      fulfillmentOrders { id }
                      userErrors { field message }
                    }
                  }
                `;

                const graphqlResult = await shopifyAdminGraphql<{
                  data?: {
                    fulfillmentOrderSplit?: {
                      fulfillmentOrders?: Array<{ id: string }>;
                      userErrors?: Array<{ field?: string[]; message: string }>;
                    };
                  };
                }>(mutation, {
                  fulfillmentOrderId: fulfillmentOrderGid,
                  fulfillmentOrderSplits: [{ fulfillmentOrderLineItems: splitLineItems }],
                });
                const userErrors = graphqlResult?.data?.fulfillmentOrderSplit?.userErrors;

                if (userErrors && userErrors.length > 0) {
                  const errorMsg = userErrors.map((e: any) => e.message).join(", ");
                  console.warn(`[Fulfillment Split] Shopify userErrors: ${errorMsg}`);
                  await slack.sendWarningMessage(
                    SlackChannelEnum.SHOPIFY,
                    `[Fulfillment Split] ${shopifyOrderName}: split failed — ${errorMsg}`
                  );
                } else {
                  const newFOs =
                    graphqlResult?.data?.fulfillmentOrderSplit?.fulfillmentOrders || [];
                  console.log(
                    `[Fulfillment Split] Successfully split ${shopifyOrderName} into ${newFOs.length} fulfillment orders`
                  );

                  await slack.sendOrderMessage(
                    SlackChannelEnum.SHOPIFY,
                    `[Fulfillment Split] ${shopifyOrderName} split into ${newFOs.length} fulfillment orders ` +
                      `(total=$${orderTotal}, threshold=$${splitDecision.threshold}, country=${countryCode})`
                  );
                }
              }
            }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[Fulfillment Split] Failed for ${shopifyOrderName}: ${errorMsg}`);
          await slack.sendWarningMessage(
            SlackChannelEnum.SHOPIFY,
            `[Fulfillment Split] ${shopifyOrderName}: split check failed (non-blocking) — ${errorMsg}`
          );
        }

        // --- Send to GPS + store metafield ---
        if (shouldSendToRealGps && gpsOrderPayload) {
          await publishStatus("gps.send-order", "running", `Sending order to ${warehouseName}`, {
            warehouse: warehouseName,
          });
          try {
            const result = await gps.createOutboundOrder(
              gpsOrderPayload,
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

            return {
              type: "sync_complete" as const,
              salesOrderNumber: salesOrderNo,
              lineItems,
              d365InventoryLotsBySku,
              orderLinesSupabase,
              gpsResult: { type: "real" as const, result, metafieldStored: !!gpsOrderNo },
            };
          } catch (error) {
            if (error instanceof OutOfStockError) {
              console.log(`[GPS] ⚠️ Out of stock: ${error.message}`);
              return {
                type: "sync_complete" as const,
                salesOrderNumber: salesOrderNo,
                lineItems,
                d365InventoryLotsBySku,
                orderLinesSupabase,
                gpsResult: { type: "out_of_stock" as const, error: error.message },
              };
            }

            const errorMessage = error instanceof Error ? error.message : String(error);

            await publishStatus(
              "gps.send-order",
              "failed",
              `GPS order creation failed: ${errorMessage}. Order will continue without GPS sync.`,
              {
                error: errorMessage,
                warehouse: warehouseName,
                salesOrderNumber: salesOrderNo,
              }
            );

            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `⚠️ [GPS] Failed to create outbound order\n` +
                `Order: ${shopifyOrderName} (${salesOrderNo})\n` +
                `Warehouse: ${warehouseName}\n` +
                `Error: ${errorMessage}\n` +
                `D365 order created successfully, but GPS sync failed.`
            );

            return {
              type: "sync_complete" as const,
              salesOrderNumber: salesOrderNo,
              lineItems,
              d365InventoryLotsBySku,
              orderLinesSupabase,
              gpsResult: { type: "failed" as const, error: errorMessage },
            };
          }
        }

        if (!shouldSendToRealGps) {
          await publishStatus(
            "gps.send-order",
            "skipped",
            `GPS sync not required - ${warehouseName} uses Shopify app`,
            { warehouse: warehouseName }
          );
        }

        return {
          type: "sync_complete" as const,
          salesOrderNumber: salesOrderNo,
          lineItems,
          d365InventoryLotsBySku,
          orderLinesSupabase,
          gpsResult: {
            type: "skipped" as const,
            reason: !shouldSendToRealGps
              ? `GPS sync not required - ${warehouseName} uses Shopify app`
              : "GPS sync disabled or no payload",
          },
        };
      });

      // Handle existing order early return
      if (syncResult.type === "already_exists") {
        const reusedSalesOrderNumber = syncResult.salesOrderNumber;
        await publishStatus(
          "create-d365-order",
          "completed",
          `Existing D365 order reused: ${reusedSalesOrderNumber}`,
          { d365OrderNumber: reusedSalesOrderNumber, reused: true }
        );

        type ExistingOrderGpsRetryResult =
          | { type: "real"; gpsOrderNo?: string }
          | { type: "skipped"; reason: string }
          | { type: "failed"; error: string };

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
              warehouseName
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
                type: "failed" as const,
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

        const gpsSyncStatus =
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

        await Promise.allSettled([
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
              status: "completed",
              processingStatus: "completed",
              d365SyncStatus: "synced",
              gpsSyncStatus,
              lastError: gpsRetryResult.type === "failed" ? gpsRetryResult.error : null,
              lastErrorType: gpsRetryResult.type === "failed" ? "gps_error" : null,
              retryAt: null,
            },
            { inngestIdempotencyKey, inngestRunId }
          ),
        ]).catch(() => {});

        await handOffSequencedRunIfAny({
          status: "already_exists",
          d365OrderNumber: reusedSalesOrderNumber,
        });

        return {
          status: "already_exists",
          d365OrderNumber: reusedSalesOrderNumber,
          gpsSyncStatus,
          gpsOrderNo: gpsRetryResult.type === "real" ? gpsRetryResult.gpsOrderNo : undefined,
          shopifyOrderId,
        };
      }

      // Extract results from the mega-step
      salesOrderNumber = syncResult.salesOrderNumber;
      const salesOrderNo = salesOrderNumber!;
      d365InventoryLotsBySku = syncResult.d365InventoryLotsBySku || {};
      const gpsResult = syncResult.gpsResult;

      // Publish GPS result
      if (gpsResult.type === "real" && "result" in gpsResult) {
        const gpsOrderNo = gpsResult.result?.response?.data?.[0]?.orderNo;
        await publishStatus(
          "gps.send-order",
          "completed",
          `GPS order created: ${gpsOrderNo || "OK"}`,
          { gpsOrderNo, warehouse: warehouseName }
        );
        if (gpsOrderNo) {
          await publishStatus(
            "gps.store-metafield",
            "completed",
            `Metafield stored: ${gpsOrderNo}`,
            { gpsOrderNo }
          );
          await csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: salesOrderNo,
              warehouse: warehouseName,
              gpsOrderId: gpsOrderNo,
              gpsSyncStatus: "synced",
            },
            { inngestIdempotencyKey, inngestRunId }
          );
        }
      } else if (gpsResult.type === "failed") {
        console.log(`[GPS] Order processing will continue despite GPS failure`);
      } else if (gpsResult.type === "skipped") {
        await publishStatus("gps.send-order", "skipped", "GPS sync not required for this order");
      }

      // Handle inventory errors — emit to backorder queue for durable retry
      let routedToBackorder = false;
      if (gpsResult.type === "out_of_stock") {
        const oosError = "error" in gpsResult ? gpsResult.error : "Unknown";
        const { classifyGpsError } = await import("@/lib/clients/gps");
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

        await step.run("emit-backorder-event", async () => {
          await inngest.send({
            name: "backorder/created",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: salesOrderNumber,
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
            },
          });
        });
        routedToBackorder = true;

        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNo,
            warehouse: warehouseName,
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
              },
            },
          },
          { inngestIdempotencyKey, inngestRunId }
        );
      }

      await publishStatus("send-to-gps", "completed", "GPS warehouse order processed", {
        gpsResult,
      });

      if (!routedToBackorder) {
        await slack.sendOrderMessage(
          SlackChannelEnum.SHOPIFY,
          `Order ${shopifyOrderName} processed successfully. D365: ${salesOrderNo}`
        );
      }

      const result = {
        status: routedToBackorder ? "backorder" : "success",
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNo,
        warehouse: warehouseName,
        gpsResult,
        processedAt: new Date().toISOString(),
      };

      // Extract GPS order ID for use in final events
      let gpsOrderId: string | undefined;
      const gpsSkipped = gpsResult?.type === "skipped";

      if (gpsResult?.type === "real" && "result" in gpsResult) {
        const gpsData = gpsResult.result?.response?.data;
        if (Array.isArray(gpsData) && gpsData.length > 0) {
          gpsOrderId = (gpsData[0] as any)?.outboundOrderNo || (gpsData[0] as any)?.orderNo;
        }
      }

      if (routedToBackorder) {
        await publishResult("failed", {
          d365OrderNumber: salesOrderNo,
          warehouse: warehouseName,
          error: "Order moved to backorder queue due to inventory issue",
        });
      } else {
        await publishResult("success", {
          d365OrderNumber: salesOrderNo,
          gpsOrderNo: gpsOrderId,
          warehouse: warehouseName,
        });
      }

      if (!routedToBackorder) {
        Promise.allSettled([
          csPlatform.sendOrderCreated(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: salesOrderNo,
              warehouse: warehouseName,
              gpsOrderId,
              gpsUkOrderId:
                isGpsUkWarehouse(warehouseName) && gpsOrderId
                  ? gpsOrderId
                  : undefined,
              gpsSkipped,
              orderJson: order,
              ...(Object.keys(d365InventoryLotsBySku).length > 0
                ? { state: { d365InventoryLotsBySku } }
                : {}),
            },
            { inngestIdempotencyKey, inngestRunId }
          ),
          csPlatform.sendOrderUpdate(
            {
              id: shopifyOrderId,
              name: shopifyOrderName,
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: salesOrderNo,
              warehouse: warehouseName,
              gpsOrderId,
              gpsUkOrderId:
                isGpsUkWarehouse(warehouseName) && gpsOrderId
                  ? gpsOrderId
                  : undefined,
              status: "completed",
              processingStatus: "completed",
              d365SyncStatus: "synced",
              gpsSyncStatus:
                gpsResult?.type === "real" ? "synced" : gpsSkipped ? "skipped" : "pending",
              lastError: null,
              lastErrorType: null,
              retryAt: null,
              ...(Object.keys(d365InventoryLotsBySku).length > 0
                ? { state: { d365InventoryLotsBySku } }
                : {}),
            },
            { inngestIdempotencyKey, inngestRunId }
          ),
        ]).catch(() => {});
      }

      if (routedToBackorder) {
        throw new NonRetriableError(
          `[BACKORDER_TERMINAL] ${shopifyOrderName} moved to backorder queue due to inventory issue`
        );
      }

      // Emit processing time summary
      const totalProcessingMs = Date.now() - _orderProcessingStart;
      const sortedSteps = [...stepDurations].sort((a, b) => b.durationMs - a.durationMs);
      logFlowEvent({
        level: "info",
        flow: "order_paid",
        step: "processing_summary",
        runId: inngestRunId,
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNo,
        status: "completed",
        durationMs: totalProcessingMs,
        payload: {
          totalProcessingMs,
          stepCount: sortedSteps.length,
          slowestSteps: sortedSteps.slice(0, 5).map((s) => ({
            step: s.step,
            durationMs: s.durationMs,
            pct: Math.round((s.durationMs / totalProcessingMs) * 100),
          })),
          allSteps: sortedSteps,
        },
      });
      await flushFlowLogs();

      await handOffSequencedRunIfAny({
        status: "completed",
        d365OrderNumber: salesOrderNumber,
      });

      return result;
    } catch (error) {
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
        : normalizedError.includes("out of stock") ||
            normalizedError.includes("inventory insufficient")
          ? "out_of_stock"
          : normalizedError.includes("order routing") ||
              (normalizedError.includes("location") &&
                normalizedError.includes("not fully configured"))
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
            normalizedError.includes("d365") || normalizedError.includes("dynamics")
              ? "d365"
              : "gps";
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
            },
          });
        });

        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNumber,
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
              },
            },
          },
          { inngestIdempotencyKey, inngestRunId }
        );

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

        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            status: "completed",
            processingStatus: "completed",
            d365SyncStatus: "synced",
            d365OrderNumber: salesOrderNumber,
            lastError: `Service SKU ${serviceSkuMatch[1]} not registered in D365 (non-fatal)`,
            lastErrorType: "service_sku_missing",
          },
          { inngestIdempotencyKey, inngestRunId }
        );

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
        await publishResult("failed", {
          error: errorMsg,
          d365OrderNumber: salesOrderNumber,
        });

        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            status: "failed",
            processingStatus: "failed",
            gpsSyncStatus: "failed",
            error: errorMsg,
            lastError: errorMsg,
            errorType: nonRetryableErrorType,
            lastErrorType: nonRetryableErrorType,
          },
          { inngestIdempotencyKey, inngestRunId }
        );

        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `[Non-Retryable] ${shopifyOrderName}: ${errorMsg}`
        );

        return {
          status: "failed",
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

      // Persist terminal failure back to Battle Hub via webhook so Orders/Testing
      // can report final run errors even when a run fails before a normal status update.
      await csPlatform.sendOrderUpdate(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          status: "failed",
          processingStatus: "failed",
          gpsSyncStatus: "failed",
          error: errorMsg,
          lastError: errorMsg,
          errorType,
          lastErrorType: errorType,
        },
        { inngestIdempotencyKey, inngestRunId }
      );

      const channel = slack.determineErrorChannel(errorMsg);
      await slack.sendErrorMessage(
        channel,
        `Process Order Failed: ${shopifyOrderName} - ${errorMsg}`
      );
      throw error;
    }
  }
);
