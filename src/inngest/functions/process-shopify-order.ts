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
import { setGpsOrderMetafield } from "@/lib/clients/shopify";
import { OutOfStockError } from "@/lib/clients/gps";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculatePrepaymentAmount,
  shouldSendToGps,
} from "@/lib/transformers/order";
import { type WarehouseName } from "@/lib/helpers/warehouse";
import { validateOrderCompletely } from "@/lib/utils/validation";
import {
  getDataAreaIdForLocationAndCountry,
  getLocationRoutingDebugContext,
  getWarehouseNameForLocation,
  findLocationByWarehouseName,
} from "@/lib/services/location-routing";
import { determineWarehouse } from "@/lib/helpers/warehouse";
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
import { SlackChannelEnum } from "@/lib/types/slack";

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
      !String(fo?.assigned_location?.name || "").toLowerCase().includes("virtual")
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
    m.includes("未维护新品")
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
    // Warehouse/configuration issues
    m.includes("unknown warehouse") ||
    m.includes("unsupported warehouse") ||
    m.includes("unsupported virtual warehouse") ||
    m.includes("not fully configured in battle hub")
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
  return "out_of_stock";
}

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",
    name: "Process Shopify Order",
    idempotency: "event.data.shopifyOrderId",
    retries: RETRY_CONFIGS.DEFAULT,
    // OPTIMIZATION: Enable optimized parallelism to reduce HTTP requests by 50%
    // This reduces Inngest overhead from 2 requests/step to 1 request/step
    // @see https://inngest.com/docs/guides/step-parallelism#optimizing-parallel-step-performance
    optimizeParallelism: true,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        // OPTIMIZATION: Increased from 3 to 5 per country for higher throughput
        limit: 5,
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
  },
  [{ event: "shopify/order.created" }, { event: "shopify/order.paid" }],
  async ({ event, step, publish, runId }: { event: any; step: any; publish: any; runId: any }) => {
    const { shopifyOrderId: rawShopifyOrderId, shopifyOrderName, orderJson } = event.data;
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

    // Track step start times for duration calculation
    const stepStartTimes = new Map<string, number>();

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
        }
      }

      try {
        await publish({
          channel: `order:${shopifyOrderName}`,
          topic: "status",
          data: {
            orderName: shopifyOrderName,
            inngestIdempotencyKey,
            inngestRunId,
            step: stepName,
            status,
            message,
            data,
            durationMs, // Include step duration for completed/failed steps
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        // Don't fail the function if realtime publish fails
        console.warn(`[Realtime] Failed to publish status: ${err}`);
      }
    };

    // Helper to publish final result
    const publishResult = async (
      status: "success" | "failed" | "skipped",
      resultData?: { d365OrderNumber?: string; warehouse?: string; error?: string }
    ) => {
      try {
        await publish({
          channel: `order:${shopifyOrderName}`,
          topic: "result",
          data: {
            orderName: shopifyOrderName,
            inngestIdempotencyKey,
            inngestRunId,
            status,
            ...resultData,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        console.warn(`[Realtime] Failed to publish result: ${err}`);
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
        const freshOrder = await getOrder(shopifyOrderId);
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
        const freshOrder = await getOrder(shopifyOrderId);
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
        const freshOrder = await getOrder(shopifyOrderId);
        console.log(
          `[Order] Refetched order ${shopifyOrderName} after ${TAG_WAIT_DURATION} delay. Tags: ${freshOrder.tags || "none"}`
        );
        return freshOrder;
      });
      await publishStatus("wait-for-tags", "completed", "Order refetched with latest tags");
      order = refreshedOrder as ShopifyOrderPayload;
    }

    // Comprehensive order validation - all checks in one place
    await publishStatus("validate-order", "running", "Validating order");
    const validation = await step.run("validate-order-completely", async () => {
      return validateOrderCompletely(order, shopifyOrderId, shopifyOrderName);
    });

    // Handle validation failures
    if (!validation.valid || validation.skip) {
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

    await publishStatus("validate-order", "completed", "Order validation passed");

    // Determine warehouse and DataAreaId strictly from Battle Hub location settings.
    // Do not fall back to country/config routing.
    const routingResult = await step.run("determine-warehouse-routing", async () => {
      const countryCode =
        order.shipping_address?.country_code || order.billing_address?.country_code || "US";
      const intendedLocationId = getIntendedLocationIdFromOrder(order);

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

      // Last resort: Shopify gave us only a virtual location.
      // Use the static country-routing table to look up the expected warehouse name,
      // then resolve the actual Battle Hub location for that warehouse.
      // This still reads all config (dataAreaId, warehouse) from Hub location settings.
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

      // Shopify may assign a virtual location for some queued/unassigned FOs.
      // For Battle Hub generated tests/reruns, honor intended_location_id when present.
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
        warehouseName: warehouseNameFromLocation as WarehouseName,
        dataAreaId: locationDataAreaId,
        countryCode,
        routingSource: "location" as const,
      };
    });

    const warehouseName = routingResult.warehouseName;
    const dataAreaId = routingResult.dataAreaId;
    const country_code = routingResult.countryCode;

    let salesOrderNumber: string | undefined;
    try {
      // D365 calls controlled by ENABLE_DYNAMICS_SYNC
      const skipD365 = !config.features.enableDynamicsSync;

      // 2. Check for existing D365 order (idempotency check)
      // Use shopifyOrderName since THK_ShopifyReference stores the order name (e.g., IM8-14931)
      await publishStatus("d365.check-existing", "running", "Checking for existing D365 order");
      const existingOrder = await step.run("check-existing-d365-order", async () => {
        if (skipD365) {
          console.log("[D365] Dynamics sync disabled, skipping order lookup");
          return null;
        }
        console.log(
          `[D365] Looking up existing order for Shopify Name: ${shopifyOrderName} in dataAreaId: ${dataAreaId}`
        );
        return dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
      });
      await publishStatus("d365.check-existing", "completed", "No existing order found");

      if (existingOrder) {
        await publishStatus(
          "d365.check-existing",
          "completed",
          `Existing order found: ${existingOrder.SalesOrderNumber}`,
          { d365OrderNumber: existingOrder.SalesOrderNumber }
        );
        return {
          status: "already_exists",
          d365OrderNumber: existingOrder.SalesOrderNumber,
          shopifyOrderId,
        };
      }

      await publishStatus("create-d365-order", "running", "Creating D365 sales order");

      // 2a. Create D365 Header
      await publishStatus("d365.create-header", "running", "Creating D365 sales order header");
      const d365Header = await step.run("create-d365-header", async () => {
        const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId);
        if (skipD365) {
          return { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: headerRequest };
        }
        return retryWithBackoff(() => dynamics.createSalesOrderHeaderV3(headerRequest), {
          label: `D365 header ${shopifyOrderName}`,
        });
      });

      salesOrderNumber = d365Header.SalesOrderNumber;
      if (!salesOrderNumber) {
        throw new Error(`[D365] Missing SalesOrderNumber for ${shopifyOrderName}`);
      }
      const salesOrderNo = salesOrderNumber;
      await publishStatus(
        "d365.create-header",
        "completed",
        `Header created: ${salesOrderNo}`,
        { d365OrderNumber: salesOrderNo }
      );

      // 2b. Create D365 Lines - OPTIMIZED: Parallel creation instead of sequential
      const lineItems = toD365SalesOrderLines(order, salesOrderNo, warehouseName, true, dataAreaId);
      // Update all line items with the correct dataAreaId from location routing
      lineItems.forEach((item) => {
        item.dataAreaId = dataAreaId;
      });
      await publishStatus(
        "d365.create-lines",
        "running",
        `Creating ${lineItems.length} line items`,
        { totalLines: lineItems.length }
      );
      await step.run("create-d365-lines", async () => {
        if (skipD365) {
          return lineItems;
        }

        await Promise.all(
          lineItems.map((line) =>
            retryWithBackoff(() => dynamics.createSalesOrderLine({ ...line, salesOrderNumber: salesOrderNo }), {
              label: `D365 line ${line.itemNumber}`,
              shouldRetry: (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                return !isNonRetryableOrderError(msg);
              },
            })
          )
        );
        return lineItems;
      });
      await publishStatus(
        "d365.create-lines",
        "completed",
        `Created ${lineItems.length} line items`,
        { totalLines: lineItems.length }
      );

      // 2c. Confirm D365 Order - OPTIMIZED: Smart retry replaces fixed 5s wait
      // Instead of always waiting 5s, we try immediately and only wait on "not found" errors
      // This saves 5+ seconds on most orders where propagation is instant
      await publishStatus("d365.confirm-order", "running", "Confirming D365 sales order");
      await step.run("confirm-d365-order", async () => {
        if (skipD365) {
          return;
        }

        // OPTIMIZATION: Exponential backoff starting at 500ms instead of fixed 5s wait
        // Typical success: 1st or 2nd attempt (0-1s total)
        // Worst case: 500ms + 1000ms + 2000ms = 3.5s (still faster than old 5s + 3s*3)
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
            return;
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
      });
      await publishStatus("d365.confirm-order", "completed", "D365 order confirmed");

      // OPTIMIZATION: Run D365 prepayment + GPS payload building in PARALLEL
      // This saves ~4s by overlapping these independent operations
      const prepaymentAmount = calculatePrepaymentAmount(order);
      // Only sync to GPS if warehouse is actually a GPS warehouse
      // Stord orders are already syncing via Shopify app, so skip GPS sync for Stord
      const shouldSendToRealGps =
        shouldSendToGps(order, warehouseName) && config.features.enableGpsSync;

      // Start both operations simultaneously
      if (prepaymentAmount > 0) {
        await publishStatus(
          "d365.create-prepayment",
          "running",
          `Creating prepayment: $${prepaymentAmount.toFixed(2)}`,
          { amount: prepaymentAmount }
        );
      }
      await publishStatus("gps.build-payload", "running", "Transforming order to GPS format");

      // Run prepayment and GPS payload building in parallel using Promise.all with step.run
      const [prepaymentResult, gpsOrderPayload] = await Promise.all([
        // 3. Create Prepayment (runs in parallel)
        step.run("create-d365-prepayment", async () => {
          if (skipD365 || prepaymentAmount <= 0) {
            return { success: true, amount: prepaymentAmount };
          }

          try {
            await dynamics.createPrepayment(salesOrderNo, dataAreaId);
            return { success: true, amount: prepaymentAmount };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isNumberSequenceError =
              errorMessage.includes("Number sequence") &&
              errorMessage.includes("has been exceeded");

            if (isNumberSequenceError) {
              // D365 number sequence exceeded - this is a configuration issue
              // Log as skipped and continue processing (prepayment is not critical for fulfillment)
              await publishStatus(
                "d365.create-prepayment",
                "skipped",
                `Prepayment skipped: D365 number sequence exceeded. Order will continue without prepayment.`,
                {
                  amount: prepaymentAmount,
                  error: "number_sequence_exceeded",
                  salesOrderNumber: salesOrderNo,
                }
              );

              await slack.sendWarningMessage(
                SlackChannelEnum.SHOPIFY,
                `⚠️ [D365] Number sequence exceeded for prepayment\n` +
                  `Order: ${shopifyOrderName} (${salesOrderNo})\n` +
                  `Error: ${errorMessage}\n` +
                  `Action Required: Extend number sequence U001-JBN in D365`
              );

              return {
                success: false,
                amount: prepaymentAmount,
                error: "number_sequence_exceeded",
              };
            }

            // For other prepayment errors, still log but don't fail the order
            await publishStatus(
              "d365.create-prepayment",
              "skipped",
              `Prepayment failed: ${errorMessage}. Order will continue without prepayment.`,
              {
                amount: prepaymentAmount,
                error: errorMessage,
                  salesOrderNumber: salesOrderNo,
              }
            );

            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `⚠️ [D365] Prepayment creation failed for ${shopifyOrderName} (${salesOrderNo}): ${errorMessage}`
            );

            return { success: false, amount: prepaymentAmount, error: errorMessage };
          }
        }),

        // 4a. Build GPS payload (runs in parallel with prepayment)
        step.run("build-gps-payload", async () => {
          try {
            return toGpsOutboundOrder(order, salesOrderNo, warehouseName);
          } catch (error) {
            await slack.sendWarningMessage(
              "gps",
              `Failed to build GPS payload for ${shopifyOrderName}: ${error}`
            );
            return null;
          }
        }),
      ]);

      // Publish results after parallel completion
      if (prepaymentAmount > 0) {
        if (prepaymentResult.success) {
          await publishStatus(
            "d365.create-prepayment",
            "completed",
            `Prepayment created: $${prepaymentAmount.toFixed(2)}`,
            { amount: prepaymentAmount }
          );
        }
        // If prepayment failed, status was already published in the step.run catch block
      }

      if (gpsOrderPayload) {
        const itemCount = gpsOrderPayload.productList?.length || 0;
        await publishStatus(
          "gps.build-payload",
          "completed",
          `Payload built with ${itemCount} items`,
          {
            itemCount,
            warehouse: warehouseName,
          }
        );
      } else {
        await publishStatus("gps.build-payload", "skipped", "No GPS payload required");
      }

      await publishStatus(
        "create-d365-order",
        "completed",
        `D365 order created: ${salesOrderNo}`,
        { d365OrderNumber: salesOrderNo }
      );

      // 4. Send to GPS (if applicable)
      // Only GPS warehouses need syncing - Stord has its own Shopify app
      await publishStatus("send-to-gps", "running", "Preparing GPS warehouse order");

      // 4b. Send to GPS warehouse + store metafield in SINGLE step
      // OPTIMIZATION: Consolidated GPS send + metafield store into one step
      // This eliminates ~4s of Inngest step overhead
      if (shouldSendToRealGps && gpsOrderPayload) {
        await publishStatus("gps.send-order", "running", `Sending order to ${warehouseName}`, {
          warehouse: warehouseName,
        });
      } else if (!shouldSendToRealGps) {
        // Skip GPS sync for non-GPS warehouses (e.g., Stord - handled by Shopify app)
        await publishStatus(
          "gps.send-order",
          "skipped",
          `GPS sync not required - ${warehouseName} uses Shopify app`,
          { warehouse: warehouseName }
        );
      }

      const gpsResult = await step.run("send-to-gps-and-store-metafield", async () => {
        // If GPS is enabled and we have a payload, make the real call
        if (shouldSendToRealGps && gpsOrderPayload) {
          try {
            const result = await gps.createOutboundOrder(
              gpsOrderPayload,
              warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
            );

            // OPTIMIZATION: Store metafield immediately after GPS success (same step)
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

            return { type: "real", result, metafieldStored: !!gpsOrderNo };
          } catch (error) {
            if (error instanceof OutOfStockError) {
              console.log(`[GPS] ⚠️ Out of stock: ${error.message}`);
              return { type: "out_of_stock", error: error.message };
            }

            // Handle other GPS errors gracefully - don't fail the entire order
            // The order has already been created in D365, so we log the error and continue
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isGpsApiError = errorMessage.includes("GPS API error");

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

            return { type: "failed", error: errorMessage };
          }
        }

        // Skip if GPS not enabled or not a GPS warehouse
        if (!shouldSendToRealGps) {
          return {
            type: "skipped",
            reason: `GPS sync not required - ${warehouseName} uses Shopify app`,
          };
        }
        return { type: "skipped", reason: "GPS sync disabled or no payload" };
      });

      // Publish GPS result
      if (gpsResult.type === "real" && "result" in gpsResult) {
        const gpsOrderNo = gpsResult.result?.response?.data?.[0]?.orderNo;
        await publishStatus(
          "gps.send-order",
          "completed",
          `GPS order created: ${gpsOrderNo || "OK"}`,
          {
            gpsOrderNo,
            warehouse: warehouseName,
          }
        );
        if (gpsOrderNo) {
          await publishStatus(
            "gps.store-metafield",
            "completed",
            `Metafield stored: ${gpsOrderNo}`,
            { gpsOrderNo }
          );
        }
      } else if (gpsResult.type === "failed") {
        // Status already published in the catch block above
        console.log(`[GPS] Order processing will continue despite GPS failure`);
      } else if (gpsResult.type === "skipped") {
        await publishStatus("gps.send-order", "skipped", "GPS sync not required for this order");
      }

      // Handle inventory errors — emit to backorder queue for durable retry
      let routedToBackorder = false;
      if (gpsResult.type === "out_of_stock" && gpsOrderPayload) {
        const oosError = "error" in gpsResult ? gpsResult.error : "Unknown";
        const { classifyGpsError } = await import("@/lib/clients/gps");
        const errorType = classifyGpsError(oosError);
        const failedSkus =
          gpsOrderPayload.productList?.map(
            (p: { sku?: string; itemNumber?: string }) => p.sku || p.itemNumber || "unknown"
          ) || [];

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

        // Emit backorder event for durable retry with step.waitForEvent
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
              // Out-of-stock/master-data issues should be parked, not loop-retried.
              maxRetries: 0,
              createdAt: new Date().toISOString(),
            },
          });
        });
        routedToBackorder = true;

        // Notify Battle Hub
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

      // Publish final success result
      if (routedToBackorder) {
        await publishResult("failed", {
          d365OrderNumber: salesOrderNo,
          warehouse: warehouseName,
          error: "Order moved to backorder queue due to inventory issue",
        });
      } else {
        await publishResult("success", {
          d365OrderNumber: salesOrderNo,
          warehouse: warehouseName,
        });
      }

      // Send order created event to CS platform (Battle Hub)
      let gpsOrderId: string | undefined;
      const gpsSkipped = gpsResult?.type === "skipped";

      if (gpsResult?.type === "real" && "result" in gpsResult) {
        const gpsData = gpsResult.result?.response?.data;
        if (Array.isArray(gpsData) && gpsData.length > 0) {
          gpsOrderId = (gpsData[0] as any)?.outboundOrderNo || (gpsData[0] as any)?.orderNo;
        }
      }

      // IMPORTANT: Do not overwrite backorder status with a generic "order created" update.
      if (!routedToBackorder) {
        await csPlatform.sendOrderCreated(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNo,
            warehouse: warehouseName,
            gpsOrderId,
            gpsSkipped, // Pass GPS skip status for sync tracking
            orderJson: order,
          },
          { inngestIdempotencyKey, inngestRunId }
        );
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const normalizedError = errorMsg.toLowerCase();
      const errorType =
        normalizedError.includes("out of stock") ||
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
          order?.line_items
            ?.map((p: { sku?: string }) => p.sku || "unknown")
            .filter(Boolean) || [];

        await step.run("emit-backorder-event-on-catch", async () => {
          await inngest.send({
            name: "backorder/created",
            data: {
              shopifyOrderId,
              shopifyOrderName,
              d365OrderNumber: salesOrderNumber,
              warehouse:
                order?.shipping_address?.country_code === "GB"
                  ? "GPS UK Warehouse"
                  : "GPS Warehouse",
              errorMessage: errorMsg,
              errorType: inventoryErrorType,
              failedSkus,
              retryCount: 0,
              // Out-of-stock/master-data issues should be parked, not loop-retried.
              maxRetries: 0,
              createdAt: new Date().toISOString(),
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

        return {
          status: "backorder",
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          error: errorMsg,
          errorType: inventoryErrorType,
          processedAt: new Date().toISOString(),
        };
      }

      // Non-retryable configuration/master-data errors: record and stop here.
      // Do not rethrow, so Inngest function-level retries are avoided.
      if (isNonRetryableOrderError(errorMsg)) {
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
            errorType: "non_retryable_data_error",
            lastErrorType: "non_retryable_data_error",
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
          errorType: "non_retryable_data_error",
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
