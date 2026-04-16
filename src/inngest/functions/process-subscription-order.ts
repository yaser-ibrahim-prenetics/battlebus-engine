// ============================================================================
// SUBSCRIPTION RENEWAL ORDER PROCESSING (Skio / Prive)
// ============================================================================
// Handles orders where source_name === 'subscription_contract'
// These get higher concurrency, faster retries, and tag-wait logic.
//
// Key differences from process-shopify-order:
//   1. Skips the 5-minute delay (subscription orders are pre-validated)
//   2. Checks for subscription reward tags — reschedules for up to 5 min if missing (configurable)
//   3. Higher concurrency limit (Skio can burst 50+ orders at once)
//   4. Maps refill SKUs to their Dynamics counterparts

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import { setGpsOrderMetafield, getOrder as shopifyGetOrder } from "@/lib/clients/shopify";
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
  type OrderLineRecord,
} from "@/lib/services/supabase-order-lines";
import { type WarehouseName } from "@/lib/helpers/warehouse";
import { validateOrderCompletely } from "@/lib/utils/validation";
import {
  getDataAreaIdForLocationAndCountry,
  getLocationRoutingDebugContext,
  getWarehouseNameForLocation,
  findLocationByWarehouseName,
  resolveStordHubWhenFulfillmentLocationUnmapped,
} from "@/lib/services/location-routing";
import { determineWarehouse } from "@/lib/helpers/warehouse";
import { getFulfillmentOrders } from "@/lib/clients/shopify";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
  retryWithBackoff,
  SUBSCRIPTION_TAG_WAIT_MINUTES,
  SUBSCRIPTION_TAG_WAIT_WARN_ENABLED,
} from "@/lib/utils/constants";
import { type ShopifyOrderPayload } from "../events";
import { SlackChannelEnum } from "@/lib/types/slack";
import { NonRetriableError } from "inngest";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

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

function isNonRetryableOrderError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("out of stock") ||
    m.includes("inventory insufficient") ||
    m.includes("cannot be reserved") ||
    (m.includes("item number") && m.includes("does not exist")) ||
    m.includes("sku有误") ||
    m.includes("未维护新品") ||
    m.includes("未通过审核") ||
    m.includes("unknown warehouse") ||
    m.includes("unsupported warehouse") ||
    m.includes("unsupported virtual warehouse") ||
    m.includes("not fully configured in battle hub")
  );
}

function isServiceSkuItemNumber(itemNumber?: string | null): boolean {
  const sku = String(itemNumber || "").toUpperCase();
  return sku.startsWith("IM8-SER-") || sku.startsWith("PRE-SER-");
}

function isD365ItemNotFoundError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return m.includes("item number") && m.includes("does not exist");
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Detect whether a subscription order has a refill SKU but is missing
 * the required "Subscription order" tag (Skio applies it async after creation).
 * Mirrors spock-store's isUnTaggedRefillOrder.
 */
function isRefillOrder(order: ShopifyOrderPayload): boolean {
  const tags = (order.tags || "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim());

  const hasRefillTag = tags.some(
    (t) => t.includes("refill") || t.includes("renewal") || t.includes("subscription order")
  );

  // Any SKU that is mapped in the refill mapping (IM8-FG-000010 etc.) indicates a refill
  const hasRefillSku = order.line_items.some(
    (item) => item.sku && !item.gift_card && item.requires_shipping
  );

  return hasRefillSku && !hasRefillTag;
}

/**
 * Extract the Skio subscription contract ID from note_attributes.
 */
function extractSubscriptionContractId(order: ShopifyOrderPayload): string {
  const attrs = order.note_attributes || [];
  return attrs.find((a) => a.name === "subscription_id" || a.name === "contract_id")?.value || "";
}

// ============================================================================
// FUNCTION DEFINITION
// ============================================================================

export const processSubscriptionOrder = inngest.createFunction(
  {
    id: "process-subscription-order",
    name: "Process Subscription Renewal Order (Skio)",
    idempotency: "event.data.shopifyOrderId",
    // Higher retries: subscription failures are customer-impacting
    retries: RETRY_CONFIGS.CRITICAL,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.shopifyStore",
    },
    // Higher concurrency: Skio can burst many renewals at once
    concurrency: [
      {
        limit: parseInt(process.env.CONCURRENCY_SUBSCRIPTION || "10", 10),
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.FULFILLMENT,
      key: "event.data.shopifyOrderId",
    },
    triggers: [{ event: "shopify/subscription.renewed" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const {
      shopifyOrderId: rawShopifyOrderId,
      shopifyOrderName,
      subscriptionContractId,
      shopifyStore,
    } = event.data;
    const isRerun =
      Boolean(event.data.originalShopifyOrderId) ||
      String(rawShopifyOrderId || "").includes("-rerun-");
    // Reruns append "-rerun-<ts>" to shopifyOrderId for idempotency.
    // Always use canonical Shopify order ID for Shopify API calls and persistence.
    const shopifyOrderId = String(
      event.data.originalShopifyOrderId || String(rawShopifyOrderId || "").split("-rerun-")[0]
    );
    let order = event.data.orderJson as ShopifyOrderPayload;

    const _flowStart = Date.now();
    const _runId = (event as any).id;

    await logFlowEvent({ flow: "subscription_renewal", step: "start", status: "started", runId: _runId, shopifyOrderId, shopifyOrderName, payload: { subscriptionContractId } });

    console.log(`[Subscription] ========================================`);
    console.log(
      `[Subscription] Processing renewal: ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"})`
    );

    // =========================================================================
    // STEP 1: Re-fetch order to get the latest tags (Skio applies tags async)
    // =========================================================================
    const refreshedOrder = await step.run("refetch-order-for-tags", async () => {
      const fresh = await shopifyGetOrder(shopifyOrderId, shopifyStore);
      console.log(
        `[Subscription] Refetched ${shopifyOrderName}. Tags: "${fresh.tags || "(none)"}"`
      );
      return fresh;
    });
    order = refreshedOrder as ShopifyOrderPayload;

    // =========================================================================
    // STEP 2: Tag-wait — if refill order but subscription tag missing, wait
    // =========================================================================
    const tagsMissing = await step.run("check-subscription-tags", async () => {
      return isRefillOrder(order);
    });

    if (tagsMissing && !isRerun) {
      console.log(
        `[Subscription] ⚠️  Order ${shopifyOrderName} is a refill but missing subscription tag. Waiting ${SUBSCRIPTION_TAG_WAIT_MINUTES} min for Skio to apply tags...`
      );

      // Wait for the tag to appear (Skio applies tags within seconds, 5min default is sufficient)
      await step.sleep("wait-for-subscription-tags", `${SUBSCRIPTION_TAG_WAIT_MINUTES}m`);

      // Re-fetch once more
      const reOrderAfterWait = await step.run("refetch-after-tag-wait", async () => {
        const fresh = await shopifyGetOrder(shopifyOrderId, shopifyStore);
        console.log(
          `[Subscription] Post-wait refetch ${shopifyOrderName}. Tags: "${fresh.tags || "(none)"}"`
        );
        return fresh;
      });
      order = reOrderAfterWait as ShopifyOrderPayload;

      // Still missing — alert and continue processing (do not block indefinitely)
      if (isRefillOrder(order)) {
        if (SUBSCRIPTION_TAG_WAIT_WARN_ENABLED) {
          await step.run("alert-missing-subscription-tags", async () => {
            await slack.sendWarningMessage(
              SlackChannelEnum.SHOPIFY,
              `[Subscription] Subscription tag still missing after ${SUBSCRIPTION_TAG_WAIT_MINUTES}min for ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"}). Proceeding without tag — check Skio webhook delivery.`
            );
          });
        }
        console.warn(
          `[Subscription] Tag still missing after ${SUBSCRIPTION_TAG_WAIT_MINUTES}min for ${shopifyOrderName}. Proceeding anyway.`
        );
      }
    } else if (tagsMissing && isRerun) {
      console.log(
        `[Subscription] Rerun detected for ${shopifyOrderName}; skipping subscription tag wait delay`
      );
    }

    // =========================================================================
    // STEP 3: Validate order
    // =========================================================================
    const validation = await step.run("validate-subscription-order", async () => {
      return validateOrderCompletely(order, shopifyOrderId, shopifyOrderName);
    });

    if (!validation.valid && !validation.skip) {
      console.log(
        `[Subscription] ⏭️  Skipping ${shopifyOrderName}: ${validation.status} — ${validation.reason}`
      );
      return { status: validation.status, reason: validation.reason };
    }

    // =========================================================================
    // STEP 4: Determine warehouse and dataAreaId strictly from Battle Hub
    // location settings. No country/config fallback.
    // =========================================================================
    const warehouseInfo = await step.run("determine-warehouse", async () => {
      const country_code =
        order.shipping_address?.country_code || order.billing_address?.country_code || "US";
      const intendedLocationId = getIntendedLocationIdFromOrder(order);

      let fulfillmentLocationId: number | undefined;
      try {
        const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
        const selectedId = selectPreferredFulfillmentLocationId(fulfillmentOrders as any[]);
        fulfillmentLocationId = selectedId ?? undefined;
      } catch {
        console.warn(`[Subscription] Could not fetch fulfillment orders for ${shopifyOrderName}`);
      }

      if (!fulfillmentLocationId && intendedLocationId) {
        fulfillmentLocationId = intendedLocationId;
        console.log(
          `[Subscription Routing] Using intended_location_id=${intendedLocationId} from order note attributes for ${shopifyOrderName}`
        );
      }

      if (!fulfillmentLocationId) {
        const expectedWarehouseName = determineWarehouse(country_code);
        const hubLocation = await findLocationByWarehouseName(expectedWarehouseName, "im8");
        if (hubLocation?.shopifyLocationId) {
          fulfillmentLocationId = Number(hubLocation.shopifyLocationId);
          console.warn(
            `[Subscription Routing] ${shopifyOrderName}: Shopify only assigned a virtual location. ` +
            `Resolved to "${expectedWarehouseName}" (id=${fulfillmentLocationId}) via country=${country_code} + Battle Hub config.`
          );
        } else {
          throw new Error(
            `[Subscription Routing] No Shopify fulfillment location assigned for ${shopifyOrderName} and no Battle Hub location is configured for country=${country_code} (expected warehouse: ${expectedWarehouseName}). ` +
            `Configure the location in Battle Hub Locations settings.`
          );
        }
      }

      let locationDataAreaId = await getDataAreaIdForLocationAndCountry(
        fulfillmentLocationId,
        country_code,
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
            country_code,
            "im8"
          );
          warehouseNameFromLocation = intendedWarehouse;
          console.log(
            `[Subscription Routing] Switched from virtual location to intended_location_id=${intendedLocationId} for ${shopifyOrderName}`
          );
        }
      }

      if (!locationDataAreaId || !warehouseNameFromLocation) {
        const stordHub = await resolveStordHubWhenFulfillmentLocationUnmapped(
          order,
          country_code,
          "im8"
        );
        if (stordHub) {
          const unknownLoc = fulfillmentLocationId;
          locationDataAreaId = stordHub.dataAreaId;
          warehouseNameFromLocation = stordHub.warehouseName;
          fulfillmentLocationId = Number(stordHub.hubShopifyLocationId);
          console.warn(
            `[Subscription Routing] ${shopifyOrderName}: fulfillment location ${unknownLoc} is not in Battle Hub; ` +
              `all lines use fulfillment_service=stord — using configured "${stordHub.warehouseName}" ` +
              `(hub Shopify location id ${stordHub.hubShopifyLocationId}). ` +
              `Add or update this location in Battle Hub (shopify_location_id=${unknownLoc}).`
          );
        }
      }

      if (!locationDataAreaId || !warehouseNameFromLocation) {
        const routingContext = await getLocationRoutingDebugContext(
          fulfillmentLocationId,
          country_code,
          "im8"
        );
        throw new Error(
          `[Subscription Routing] Shopify location ${fulfillmentLocationId} is not fully configured in Battle Hub for country ${country_code}. Set the location warehouse name and dataAreaId/country override in Locations; country fallback is disabled. Context: ${routingContext}`
        );
      }

      if (String(warehouseNameFromLocation).toLowerCase().includes("virtual")) {
        const routingContext = await getLocationRoutingDebugContext(
          fulfillmentLocationId,
          country_code,
          "im8"
        );
        throw new Error(
          `[Subscription Routing] Unsupported virtual warehouse "${warehouseNameFromLocation}" for Shopify location ${fulfillmentLocationId}. Configure a real fulfillment location in Shopify and Battle Hub. Context: ${routingContext}`
        );
      }

      console.log(
        `[Subscription Routing] Location ${fulfillmentLocationId} → warehouse: ${warehouseNameFromLocation}, dataAreaId: ${locationDataAreaId}`
      );
      return {
        dataAreaId: locationDataAreaId,
        warehouseName: warehouseNameFromLocation as WarehouseName,
        country_code,
        routingSource: "location" as const,
      };
    });

    const { dataAreaId, warehouseName, country_code } = warehouseInfo;

    // =========================================================================
    // STEP 5: Create D365 Sales Order Header (check for existing first)
    // =========================================================================
    const existingD365Order = await step.run("check-existing-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return null;
      try {
        return await dynamics.getSalesOrderByShopifyId(shopifyOrderName, dataAreaId);
      } catch {
        return null;
      }
    });

    if (existingD365Order) {
      console.log(
        `[Subscription] ✅ D365 order already exists for ${shopifyOrderName}: ${existingD365Order.SalesOrderNumber}`
      );
      return {
        status: "already_exists",
        d365OrderNumber: existingD365Order.SalesOrderNumber,
        subscriptionContractId,
      };
    }

    const d365Header = await step.run("create-d365-order-header", async () => {
      if (!config.features.enableDynamicsSync) {
        return { status: "skipped", salesOrderNumber: "" };
      }

      const headerPayload = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId);

      const result = await retryWithBackoff(
        () => dynamics.createSalesOrderHeaderV3(headerPayload),
        { label: `D365 sub header ${shopifyOrderName}` }
      );
      console.log(
        `[Subscription] ✅ D365 header created: ${result.SalesOrderNumber} for ${shopifyOrderName}`
      );
      return { status: "created", salesOrderNumber: result.SalesOrderNumber };
    });

    if (!d365Header.salesOrderNumber) {
      return { status: "skipped", reason: "D365 sync disabled" };
    }

    const d365OrderNumber = d365Header.salesOrderNumber;

    // =========================================================================
    // STEP 6: Create D365 Order Lines
    // =========================================================================
    try {
      await step.run("create-d365-order-lines", async () => {
        if (!config.features.enableDynamicsSync) return { status: "skipped" };

        const lineItems = toD365SalesOrderLines(
          order,
          d365OrderNumber,
          warehouseName,
          true,
          dataAreaId
        );

        const lineResults = await Promise.all(
          lineItems.map((line) =>
            (async () => {
              try {
                const created = await retryWithBackoff(
                  () => dynamics.createSalesOrderLine(line),
                  {
                    label: `D365 sub line ${line.itemNumber}`,
                    shouldRetry: (err) => {
                      const msg = err instanceof Error ? err.message : String(err);
                      return !isNonRetryableOrderError(msg);
                    },
                  }
                );
                const lot = created?.InventoryLotId ? String(created.InventoryLotId).trim() : "";
                return { skipped: false as const, itemNumber: line.itemNumber, inventoryLotId: lot };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (isServiceSkuItemNumber(line.itemNumber) && isD365ItemNotFoundError(msg)) {
                  console.warn(
                    `[D365][Subscription] Skipping missing service SKU line ${line.itemNumber} for ${d365OrderNumber}: ${msg}`
                  );
                  return { skipped: true as const, itemNumber: line.itemNumber, error: msg };
                }
                throw err;
              }
            })()
          )
        );

        const d365InventoryLotsBySku: Record<string, string> = {};
        for (const r of lineResults) {
          if (r.skipped) continue;
          const sku = String(r.itemNumber || "").trim().toUpperCase();
          const lot = "inventoryLotId" in r ? String(r.inventoryLotId || "").trim() : "";
          if (sku && lot) d365InventoryLotsBySku[sku] = lot;
        }

        const skippedItemNumbers = new Set(
          lineResults.filter((r) => r.skipped).map((r) => r.itemNumber.toUpperCase())
        );

        const lineRecords: OrderLineRecord[] = toOrderLineRecords(
          order,
          d365OrderNumber,
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
            d365_sales_order_number: d365OrderNumber,
            data_area_id: dataAreaId,
            quantity: r.quantity,
            price: r.price,
            dynamics_inventory_lot_id:
              d365InventoryLotsBySku[r.d365ItemNumber.toUpperCase()] ?? null,
            is_service_line: r.isServiceLine,
          }));

        await saveOrderLines(lineRecords);

        console.log(
          `[Subscription] ✅ Created ${lineItems.length} D365 lines for ${shopifyOrderName}; saved ${lineRecords.length} to order_lines`
        );
        return { status: "created", lineCount: lineItems.length };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isNonRetryableOrderError(errorMsg)) {
        throw new NonRetriableError(
          `[D365_NON_RETRYABLE] ${shopifyOrderName}: ${errorMsg}`
        );
      }
      throw error;
    }

    // =========================================================================
    // STEP 7: Confirm & Prepay D365 Order
    // =========================================================================
    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      await retryWithBackoff(() => dynamics.confirmSalesOrder(d365OrderNumber, dataAreaId), {
        label: `D365 sub confirm ${d365OrderNumber}`,
      });
      console.log(`[Subscription] ✅ D365 order confirmed: ${d365OrderNumber}`);
      return { status: "confirmed" };
    });

    await step.run("prepay-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      const prepayAmount = calculatePrepaymentAmount(order);
      if (prepayAmount <= 0) return { status: "skipped", reason: "zero amount" };
      await retryWithBackoff(() => dynamics.createPrepayment(d365OrderNumber, dataAreaId), {
        label: `D365 sub prepay ${d365OrderNumber}`,
      });
      console.log(`[Subscription] ✅ D365 prepayment created: ${prepayAmount} ${order.currency}`);
      return { status: "created", amount: prepayAmount };
    });

    // =========================================================================
    // STEP 8: Create GPS Outbound Order
    // =========================================================================
    const gpsResult = await step.run("create-gps-order", async () => {
      if (!config.features.enableGpsSync)
        return { status: "skipped" as const, reason: "GPS sync disabled", gpsOrderId: undefined };
      if (!shouldSendToGps(order, warehouseName))
        return { status: "skipped" as const, reason: "Not a GPS warehouse", gpsOrderId: undefined };

      try {
        const gpsOrder = toGpsOutboundOrder(order, d365OrderNumber, warehouseName);
        const result = await gps.createOutboundOrder(
          gpsOrder,
          warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
        );
        const gpsOrderId = result?.response?.data?.[0]?.orderNo;
        console.log(`[Subscription] ✅ GPS order created: ${gpsOrderId} for ${shopifyOrderName}`);

        // Store metafield immediately (same step, saves a round-trip)
        if (gpsOrderId) {
          await setGpsOrderMetafield(shopifyOrderId, {
            gpsOrderId,
            warehouse: warehouseName,
            d365OrderNumber,
            createdAt: new Date().toISOString(),
          });
        }

        return { status: "created" as const, gpsOrderId, reason: undefined };
      } catch (err: any) {
        if (err instanceof OutOfStockError || err?.message?.includes("库存不足")) {
          console.warn(
            `[Subscription] ⚠️  OOS for ${shopifyOrderName}: ${err.message}. Parking in backorder queue.`
          );
          return {
            status: "backorder" as const,
            reason: err.message as string,
            gpsOrderId: undefined,
          };
        }
        throw err;
      }
    });

    // =========================================================================
    // STEP 9: Park OOS orders into the backorder queue
    // =========================================================================
    if (gpsResult.status === "backorder") {
      await step.sendEvent("park-backorder", {
        id: `backorder-created-sub-${shopifyOrderId}`,
        name: "backorder/created" as const,
        data: {
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber,
          warehouse: warehouseName,
          errorMessage: gpsResult.reason || "OOS",
          errorType: "out_of_stock" as const,
          failedSkus:
            order.line_items
              ?.filter((i: any) => i.requires_shipping && !i.gift_card)
              .map((i: any) => i.sku)
              .filter(Boolean) || [],
          // Park OOS in backorders, but avoid automatic retry loops.
          maxRetries: 0,
          retryCount: 0,
          createdAt: new Date().toISOString(),
        },
      });
    }

    // =========================================================================
    // STEP 10: Notify CS Platform
    // =========================================================================
    await step.run("notify-cs-platform", async () => {
      try {
        await csPlatform.sendOrderUpdate({
          shopifyOrderId,
          shopifyOrderName,
          d365OrderNumber,
          status: gpsResult.status === "backorder" ? "backorder" : "processing",
          warehouse: warehouseName,
          subscriptionContractId,
        });
      } catch (err) {
        console.warn(`[Subscription] CS Platform notify failed:`, err);
      }
      return { status: "notified" };
    });

    const finalStatus = gpsResult.status === "backorder" ? "backorder" : "completed";
    console.log(
      `[Subscription] ✅ Done: ${shopifyOrderName} → D365: ${d365OrderNumber} | GPS: ${gpsResult.gpsOrderId || gpsResult.status} | Status: ${finalStatus}`
    );
    console.log(`[Subscription] ========================================`);

    await logFlowEvent({ flow: "subscription_renewal", step: "done", status: finalStatus === "completed" ? "completed" : finalStatus, runId: _runId, shopifyOrderId, shopifyOrderName, d365OrderNumber, durationMs: Date.now() - _flowStart, payload: { gpsOrderId: gpsResult.gpsOrderId, warehouse: warehouseName } });
    return {
      status: finalStatus,
      shopifyOrderId,
      shopifyOrderName,
      d365OrderNumber,
      gpsOrderId: gpsResult.gpsOrderId,
      warehouse: warehouseName,
      subscriptionContractId,
    };
  }
);
