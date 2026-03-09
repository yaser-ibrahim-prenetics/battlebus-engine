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
import { resolveCountryRouting, type WarehouseName } from "@/lib/helpers/warehouse";
import { validateOrderCompletely } from "@/lib/utils/validation";
import {
  getDataAreaIdForLocationAndCountry,
  getWarehouseNameForLocation,
} from "@/lib/services/location-routing";
import { getFulfillmentOrders } from "@/lib/clients/shopify";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  retryWithBackoff,
} from "@/lib/utils/constants";
import { CancelReasonEnum, type ShopifyOrderPayload } from "../events";
import { SlackChannelEnum } from "@/lib/types/slack";

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
    const { shopifyOrderId, shopifyOrderName, orderJson } = event.data;
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

    // Wait 5 minutes and refetch order to ensure tags are available
    // Tags may not be immediately available when order is created
    await publishStatus(
      "wait-for-tags",
      "running",
      "Waiting 5 minutes for order tags to be available"
    );

    // Wait 5 minutes using Inngest step.sleep (must be outside step.run)
    await step.sleep("wait-for-tags", "5m");

    // Refetch order from Shopify to get latest tags
    const refreshedOrder = await step.run("refetch-order-after-delay", async () => {
      const { getOrder } = await import("@/lib/clients/shopify");
      const freshOrder = await getOrder(shopifyOrderId);
      console.log(
        `[Order] Refetched order ${shopifyOrderName} after 5min delay. Tags: ${freshOrder.tags || "none"}`
      );
      return freshOrder;
    });
    await publishStatus("wait-for-tags", "completed", "Order refetched with latest tags");

    // Use the refreshed order for all subsequent processing
    order = refreshedOrder as ShopifyOrderPayload;

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

    // Determine warehouse and DataAreaId using location-based routing
    // Priority:
    //   1. Shopify fulfillment location assignment (most specific — set by Shopify routing rules)
    //   2. Country-based routing (warehouse-config.json countryRouting + COUNTRY_ROUTING_OVERRIDES env)
    const routingResult = await step.run("determine-warehouse-routing", async () => {
      const countryCode =
        order.shipping_address?.country_code || order.billing_address?.country_code || "US";

      // 1. Try fulfillment-location-based routing (most specific)
      let fulfillmentLocationId: number | null = null;
      try {
        const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
        const openFulfillment = fulfillmentOrders.find(
          (fo: any) => fo.status === "open" || fo.status === "in_progress"
        );
        if (openFulfillment?.assigned_location_id) {
          fulfillmentLocationId = openFulfillment.assigned_location_id;
        }
      } catch (error) {
        console.warn(`[Order Routing] Could not fetch fulfillment orders: ${error}`);
      }

      if (fulfillmentLocationId) {
        // Use country-aware lookup: picks per-country dataAreaId override if configured
        const locationDataAreaId = await getDataAreaIdForLocationAndCountry(
          fulfillmentLocationId,
          countryCode,
          "im8"
        );
        const warehouseNameFromLocation = await getWarehouseNameForLocation(
          fulfillmentLocationId,
          "im8"
        );

        if (locationDataAreaId && warehouseNameFromLocation) {
          console.log(
            `[Order Routing] Location ${fulfillmentLocationId} + country ${countryCode} → warehouse: ${warehouseNameFromLocation}, dataAreaId: ${locationDataAreaId}`
          );
          return {
            warehouseName: warehouseNameFromLocation as WarehouseName,
            dataAreaId: locationDataAreaId,
            countryCode,
            routingSource: "location" as const,
          };
        }
        // Location found in Shopify but not yet in routing table — fall through
        console.warn(
          `[Order Routing] Location ${fulfillmentLocationId} not found in routing table — falling back to country routing`
        );
      }

      // 2. Country-based routing (config-driven)
      const routing = resolveCountryRouting(countryCode);
      console.log(
        `[Order Routing] Country ${countryCode} → warehouse: ${routing.warehouseName}, dataAreaId: ${routing.dataAreaId} (source: ${routing.source})`
      );
      return {
        warehouseName: routing.warehouseName,
        dataAreaId: routing.dataAreaId,
        countryCode,
        routingSource: routing.source,
      };
    });

    const warehouseName = routingResult.warehouseName;
    const dataAreaId = routingResult.dataAreaId;
    const country_code = routingResult.countryCode;

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
        const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName);
        headerRequest.dataAreaId = dataAreaId;
        if (skipD365) {
          return { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: headerRequest };
        }
        return retryWithBackoff(
          () => dynamics.createSalesOrderHeaderV3(headerRequest),
          { label: `D365 header ${shopifyOrderName}` }
        );
      });

      const salesOrderNumber = d365Header.SalesOrderNumber;
      await publishStatus(
        "d365.create-header",
        "completed",
        `Header created: ${salesOrderNumber}`,
        { d365OrderNumber: salesOrderNumber }
      );

      // 2b. Create D365 Lines - OPTIMIZED: Parallel creation instead of sequential
      const lineItems = toD365SalesOrderLines(order, salesOrderNumber, warehouseName, true);
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
            retryWithBackoff(
              () => dynamics.createSalesOrderLine({ ...line, salesOrderNumber }),
              { label: `D365 line ${line.itemNumber}` }
            )
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
            await dynamics.confirmSalesOrder(salesOrderNumber, dataAreaId);
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
            await dynamics.createPrepayment(salesOrderNumber, dataAreaId);
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
                  salesOrderNumber,
                }
              );

              await slack.sendWarningMessage(
                SlackChannelEnum.SHOPIFY,
                `⚠️ [D365] Number sequence exceeded for prepayment\n` +
                  `Order: ${shopifyOrderName} (${salesOrderNumber})\n` +
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
                salesOrderNumber,
              }
            );

            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `⚠️ [D365] Prepayment creation failed for ${shopifyOrderName} (${salesOrderNumber}): ${errorMessage}`
            );

            return { success: false, amount: prepaymentAmount, error: errorMessage };
          }
        }),

        // 4a. Build GPS payload (runs in parallel with prepayment)
        step.run("build-gps-payload", async () => {
          try {
            return toGpsOutboundOrder(order, salesOrderNumber, warehouseName);
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
        `D365 order created: ${salesOrderNumber}`,
        { d365OrderNumber: salesOrderNumber }
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
                d365OrderNumber: salesOrderNumber,
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
                salesOrderNumber,
              }
            );

            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `⚠️ [GPS] Failed to create outbound order\n` +
                `Order: ${shopifyOrderName} (${salesOrderNumber})\n` +
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
              maxRetries: 7,
              createdAt: new Date().toISOString(),
            },
          });
        });

        // Notify Battle Hub
        await csPlatform.sendOrderUpdate(
          {
            id: shopifyOrderId,
            name: shopifyOrderName,
            shopifyOrderId,
            shopifyOrderName,
            d365OrderNumber: salesOrderNumber,
            warehouse: warehouseName,
            status: "backorder",
            error: oosError,
            errorType,
          },
          { inngestIdempotencyKey, inngestRunId }
        );
      }

      await publishStatus("send-to-gps", "completed", "GPS warehouse order processed", {
        gpsResult,
      });

      await slack.sendOrderMessage(
        SlackChannelEnum.SHOPIFY,
        `Order ${shopifyOrderName} processed successfully. D365: ${salesOrderNumber}`
      );

      const result = {
        status: "success",
        shopifyOrderId,
        shopifyOrderName,
        d365OrderNumber: salesOrderNumber,
        warehouse: warehouseName,
        gpsResult,
        processedAt: new Date().toISOString(),
      };

      // Publish final success result
      await publishResult("success", {
        d365OrderNumber: salesOrderNumber,
        warehouse: warehouseName,
      });

      // Send order created event to CS platform (Battle Hub)
      let gpsOrderId: string | undefined;
      const gpsSkipped = gpsResult?.type === "skipped";

      if (gpsResult?.type === "real" && "result" in gpsResult) {
        const gpsData = gpsResult.result?.response?.data;
        if (Array.isArray(gpsData) && gpsData.length > 0) {
          gpsOrderId = (gpsData[0] as any)?.outboundOrderNo || (gpsData[0] as any)?.orderNo;
        }
      }

      await csPlatform.sendOrderCreated(
        {
          id: shopifyOrderId,
          name: shopifyOrderName,
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber: salesOrderNumber,
          warehouse: warehouseName,
          gpsOrderId,
          gpsSkipped, // Pass GPS skip status for sync tracking
          orderJson: order,
        },
        { inngestIdempotencyKey, inngestRunId }
      );

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Publish failure result
      await publishResult("failed", { error: errorMsg });

      const channel = slack.determineErrorChannel(errorMsg);
      await slack.sendErrorMessage(
        channel,
        `Process Order Failed: ${shopifyOrderName} - ${errorMsg}`
      );
      throw error;
    }
  }
);
