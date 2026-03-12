// ============================================================================
// SUBSCRIPTION RENEWAL ORDER PROCESSING (Skio / Prive)
// ============================================================================
// Handles orders where source_name === 'subscription_contract'
// These get higher concurrency, faster retries, and tag-wait logic.
//
// Key differences from process-shopify-order:
//   1. Skips the 5-minute delay (subscription orders are pre-validated)
//   2. Checks for subscription reward tags — reschedules for up to 15 min if missing
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
import { type ShopifyOrderPayload } from "../events";
import { SlackChannelEnum } from "@/lib/types/slack";

// ============================================================================
// HELPERS
// ============================================================================

const SUBSCRIPTION_TAG_WAIT_MINUTES = parseInt(
  process.env.SUBSCRIPTION_TAG_WAIT_MINUTES || "15",
  10
);

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
  return (
    attrs.find((a) => a.name === "subscription_id" || a.name === "contract_id")?.value || ""
  );
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
  },
  { event: "shopify/subscription.renewed" },
  async ({ event, step }: { event: any; step: any }) => {
    const {
      shopifyOrderId: rawShopifyOrderId,
      shopifyOrderName,
      subscriptionContractId,
    } = event.data;
    // Reruns append "-rerun-<ts>" to shopifyOrderId for idempotency.
    // Always use canonical Shopify order ID for Shopify API calls and persistence.
    const shopifyOrderId = String(
      event.data.originalShopifyOrderId ||
        String(rawShopifyOrderId || "").split("-rerun-")[0]
    );
    let order = event.data.orderJson as ShopifyOrderPayload;

    console.log(
      `[Subscription] ========================================`
    );
    console.log(
      `[Subscription] Processing renewal: ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"})`
    );

    // =========================================================================
    // STEP 1: Re-fetch order to get the latest tags (Skio applies tags async)
    // =========================================================================
    const refreshedOrder = await step.run("refetch-order-for-tags", async () => {
      const fresh = await shopifyGetOrder(shopifyOrderId);
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

    if (tagsMissing) {
      console.log(
        `[Subscription] ⚠️  Order ${shopifyOrderName} is a refill but missing subscription tag. Waiting ${SUBSCRIPTION_TAG_WAIT_MINUTES} min for Skio to apply tags...`
      );

      // Wait for the tag to appear (Skio applies tags within seconds, 15min is generous)
      await step.sleep("wait-for-subscription-tags", `${SUBSCRIPTION_TAG_WAIT_MINUTES}m`);

      // Re-fetch once more
      const reOrderAfterWait = await step.run("refetch-after-tag-wait", async () => {
        const fresh = await shopifyGetOrder(shopifyOrderId);
        console.log(
          `[Subscription] Post-wait refetch ${shopifyOrderName}. Tags: "${fresh.tags || "(none)"}"`
        );
        return fresh;
      });
      order = reOrderAfterWait as ShopifyOrderPayload;

      // Still missing — alert and continue processing (do not block indefinitely)
      if (isRefillOrder(order)) {
        await step.run("alert-missing-subscription-tags", async () => {
          await slack.sendWarningMessage(
            SlackChannelEnum.SHOPIFY,
            `[Subscription] Subscription tag still missing after ${SUBSCRIPTION_TAG_WAIT_MINUTES}min for ${shopifyOrderName} (contract: ${subscriptionContractId || "unknown"}). Proceeding without tag — check Skio webhook delivery.`
          );
        });
      }
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
    // STEP 4: Determine warehouse and dataAreaId
    // Priority: 1. Shopify fulfillment location, 2. Country routing table
    // =========================================================================
    const warehouseInfo = await step.run("determine-warehouse", async () => {
      const country_code =
        order.shipping_address?.country_code || order.billing_address?.country_code || "US";

      // 1. Try fulfillment-location routing first
      let fulfillmentLocationId: number | undefined;
      try {
        const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
        const open = fulfillmentOrders.find(
          (fo: any) => fo.status === "open" || fo.status === "in_progress"
        );
        fulfillmentLocationId = open?.assigned_location_id;
      } catch {
        console.warn(`[Subscription] Could not fetch fulfillment orders for ${shopifyOrderName}`);
      }

      if (fulfillmentLocationId) {
        const locationDataAreaId = await getDataAreaIdForLocationAndCountry(
          fulfillmentLocationId,
          country_code,
          "im8"
        );
        const warehouseNameFromLocation = await getWarehouseNameForLocation(
          fulfillmentLocationId,
          "im8"
        );
        if (locationDataAreaId && warehouseNameFromLocation) {
          console.log(
            `[Subscription Routing] Location ${fulfillmentLocationId} → warehouse: ${warehouseNameFromLocation}, dataAreaId: ${locationDataAreaId}`
          );
          return {
            dataAreaId: locationDataAreaId,
            warehouseName: warehouseNameFromLocation as WarehouseName,
            country_code,
            routingSource: "location" as const,
          };
        }
      }

      // 2. Country routing (config-driven via warehouse-config.json)
      const routing = resolveCountryRouting(country_code);
      console.log(
        `[Subscription Routing] Country ${country_code} → warehouse: ${routing.warehouseName}, dataAreaId: ${routing.dataAreaId} (source: ${routing.source})`
      );
      return {
        dataAreaId: routing.dataAreaId,
        warehouseName: routing.warehouseName,
        country_code,
        routingSource: routing.source,
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

      const headerPayload = toD365SalesOrderHeaderV3(order, warehouseName);
      headerPayload.dataAreaId = dataAreaId;

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
    await step.run("create-d365-order-lines", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };

      const lines = toD365SalesOrderLines(order, d365OrderNumber, warehouseName);

      await Promise.all(
        lines.map((line) =>
          retryWithBackoff(
            () => dynamics.createSalesOrderLine(line),
            { label: `D365 sub line ${line.itemNumber}` }
          )
        )
      );

      console.log(
        `[Subscription] ✅ Created ${lines.length} D365 lines for ${shopifyOrderName}`
      );
      return { status: "created", lineCount: lines.length };
    });

    // =========================================================================
    // STEP 7: Confirm & Prepay D365 Order
    // =========================================================================
    await step.run("confirm-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      await retryWithBackoff(
        () => dynamics.confirmSalesOrder(d365OrderNumber, dataAreaId),
        { label: `D365 sub confirm ${d365OrderNumber}` }
      );
      console.log(`[Subscription] ✅ D365 order confirmed: ${d365OrderNumber}`);
      return { status: "confirmed" };
    });

    await step.run("prepay-d365-order", async () => {
      if (!config.features.enableDynamicsSync) return { status: "skipped" };
      const prepayAmount = calculatePrepaymentAmount(order);
      if (prepayAmount <= 0) return { status: "skipped", reason: "zero amount" };
      await retryWithBackoff(
        () => dynamics.createPrepayment(d365OrderNumber, dataAreaId),
        { label: `D365 sub prepay ${d365OrderNumber}` }
      );
      console.log(
        `[Subscription] ✅ D365 prepayment created: ${prepayAmount} ${order.currency}`
      );
      return { status: "created", amount: prepayAmount };
    });

    // =========================================================================
    // STEP 8: Create GPS Outbound Order
    // =========================================================================
    const gpsResult = await step.run("create-gps-order", async () => {
      if (!config.features.enableGpsSync) return { status: "skipped" as const, reason: "GPS sync disabled", gpsOrderId: undefined };
      if (!shouldSendToGps(order, warehouseName)) return { status: "skipped" as const, reason: "Not a GPS warehouse", gpsOrderId: undefined };

      try {
        const gpsOrder = toGpsOutboundOrder(order, d365OrderNumber, warehouseName);
        const result = await gps.createOutboundOrder(
          gpsOrder,
          warehouseName as "GPS Warehouse" | "GPS UK Warehouse"
        );
        const gpsOrderId = result?.response?.data?.[0]?.orderNo;
        console.log(
          `[Subscription] ✅ GPS order created: ${gpsOrderId} for ${shopifyOrderName}`
        );

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
          return { status: "backorder" as const, reason: err.message as string, gpsOrderId: undefined };
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
          failedSkus: order.line_items
            ?.filter((i: any) => i.requires_shipping && !i.gift_card)
            .map((i: any) => i.sku)
            .filter(Boolean) || [],
          maxRetries: 7,
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
