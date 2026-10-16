import crypto from "crypto";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { fetchOrderRowsByName } from "./database-orders";
import { extractShopifyOrderId, typeLabel } from "./helpers";
import { fetchShopifyWindowOrders } from "./shopify-orders";
import { reconTrace } from "./trace";
import type { OrderRow, ReconResult, ReconType } from "./types";

export async function runOneRecon(params: {
  type: ReconType;
  dateFromIso: string;
  /** Exclusive end instant (UTC) for the Shopify window. */
  dateEndExclusiveIso: string;
  dateFrom: string;
  dateTo: string;
  storeCode: string;
  runId: string;
}): Promise<ReconResult> {
  const { type, dateFromIso, dateEndExclusiveIso, dateFrom, dateTo, storeCode, runId } = params;
  const checkId = crypto.randomUUID();
  const trace = runId ? { runId, type } : undefined;

  if (trace) {
    reconTrace(trace.runId, trace.type, "recon_start", {
      checkId,
      storeCode,
      dateFrom,
      dateTo,
      shopifyCreatedAtFromIso: dateFromIso,
      shopifyCreatedAtBeforeIso: dateEndExclusiveIso,
      windowMode: "utc",
      dateFromIso,
      dateEndExclusiveIso,
    });
  }

  // Step 1 — Pull orders via Admin GraphQL `orders` + search `query` (store-TZ date bounds).
  // SalesOrder + GPS: paid only. Fulfillment: all orders in the window (for status cross-check).
  const extraQuery = type === "fulfillment" ? undefined : "financial_status:paid";
  const shopifyOrders = await fetchShopifyWindowOrders({
    createdAtFromIso: dateFromIso,
    createdAtBeforeIso: dateEndExclusiveIso,
    extraQuery,
    trace,
  });
  const shopifyNames = shopifyOrders.map((o) => o.name);
  const shopifyIdByName = new Map<string, string>();
  for (const order of shopifyOrders) {
    const orderId = extractShopifyOrderId(order.id);
    if (orderId) shopifyIdByName.set(order.name, orderId);
  }

  // Step 2 — Look those names up in DB by name. No `created_at` filter.
  const { rows, error } = await fetchOrderRowsByName(shopifyNames, trace);

  if (error) {
    const failMessage = `${typeLabel(type)}: Error for store ${storeCode} from ${dateFrom} to ${dateTo}:\n ${checkId}: ${error.message}`;
    await slack.sendErrorMessage(SlackChannelEnum.GENERAL, failMessage);
    logFlowEvent({
      level: "error",
      flow: `reconciliation_${type}`,
      step: "daily",
      status: "failed",
      runId,
      errorType: "reconciliation_query_error",
      errorMessage: error.message,
      payload: {
        type,
        checkId,
        store: storeCode,
        dateFrom,
        dateTo,
        shopifyOrderCount: shopifyNames.length,
      },
    });
    if (trace) {
      reconTrace(trace.runId, trace.type, "recon_failed", {
        checkId,
        stage: "database_orders",
        error: error.message,
      });
    }
    return {
      type,
      checkId,
      dateFrom,
      dateTo,
      totalOrders: 0,
      matchedOrders: 0,
      unsyncedOrders: [],
      unsyncedOrderIds: [],
      status: "error",
      message: failMessage,
    };
  }

  const dbByName = new Map<string, OrderRow>();
  for (const r of rows) {
    const key = String(r.shopify_order_name || "").trim();
    if (key) dbByName.set(key, r);
  }

  // Per-type comparison + extra payload buckets for the modal.
  let unsyncedOrders: string[] = [];
  let unsyncedOrderIds: string[] = [];
  let salesorderMissingDbNames: string[] = [];
  /** GPS recons: DB row exists, warehouse matches, but GPS sync incomplete. */
  const gpsUnsyncedNames: string[] = [];
  /** Fulfillment recon: fulfilled in Shopify, not fulfilled in DB (or row missing). */
  const missingDbFulfillments: string[] = [];
  const missingDbFulfillmentIds: string[] = [];
  /** Fulfillment recon: fulfilled in DB, not fulfilled in Shopify. */
  const missingShopifyFulfillments: string[] = [];

  if (type === "salesorder") {
    salesorderMissingDbNames = shopifyNames.filter((n) => !dbByName.has(n));
    unsyncedOrders = [...salesorderMissingDbNames];
    unsyncedOrderIds = salesorderMissingDbNames
      .map((name) => shopifyIdByName.get(name) || "")
      .filter(Boolean);
  } else if (type === "gps_us" || type === "gps_uk") {
    const wh = type === "gps_us" ? "GPS Warehouse" : "GPS UK Warehouse";
    for (const name of shopifyNames) {
      const r = dbByName.get(name);
      if (!r) continue; // missing-row is salesorder recon's concern, not GPS.
      if (String(r.warehouse || "") !== wh) continue;
      const gpsOrderNoForWarehouse = type === "gps_uk" ? r.gps_uk_order_no : r.gps_order_no;
      const hasGpsId = Boolean(String(gpsOrderNoForWarehouse || "").trim());
      const gpsStatus = String(r.gps_sync_status || "").toLowerCase();
      const gpsFailed = gpsStatus === "failed";
      if (!hasGpsId || gpsFailed) {
        gpsUnsyncedNames.push(name);
      }
    }
    unsyncedOrders = Array.from(new Set(gpsUnsyncedNames));
    unsyncedOrderIds = unsyncedOrders
      .map((name) => shopifyIdByName.get(name) || "")
      .filter(Boolean);
  } else {
    // fulfillment
    for (const o of shopifyOrders) {
      const shopifyFulfilled = o.fulfillmentStatus === "FULFILLED";
      const r = dbByName.get(o.name);
      const dbFulfilled =
        !!r && String(r.shopify_fulfillment_status || "").toLowerCase() === "fulfilled";
      if (shopifyFulfilled && !dbFulfilled) {
        missingDbFulfillments.push(o.name);
        const oid = shopifyIdByName.get(o.name) || extractShopifyOrderId(o.id) || "";
        if (oid) missingDbFulfillmentIds.push(oid);
      } else if (!shopifyFulfilled && dbFulfilled) {
        missingShopifyFulfillments.push(o.name);
      }
    }
    unsyncedOrders = Array.from(new Set([...missingDbFulfillments, ...missingShopifyFulfillments]));
    unsyncedOrderIds = [...missingDbFulfillmentIds];
  }

  // Step 3 — Compose status, log, and notify.
  const status: "ok" | "error" = unsyncedOrders.length === 0 ? "ok" : "error";
  const issueKindLabel =
    type === "salesorder"
      ? "paid order(s) present in Shopify but missing in DB"
      : type === "gps_uk"
        ? "GPS UK orders missing gps_uk_order_no or GPS sync failed"
        : type === "gps_us"
          ? "GPS US orders missing gps_order_no or GPS sync failed"
          : "fulfillment discrepancies";
  const message =
    status === "ok"
      ? `${typeLabel(type)}: Order for store ${storeCode} from ${dateFrom} to ${dateTo}:\nAll orders are synced to DB.`
      : `${typeLabel(type)}: Error for store ${storeCode} from ${dateFrom} to ${dateTo}:\n ${checkId}: Found ${unsyncedOrders.length} ${issueKindLabel}:\n${unsyncedOrders.join("\n")}`;

  if (status === "ok") {
    await slack.sendInfoMessage(SlackChannelEnum.GENERAL, message);
  } else {
    await slack.sendErrorMessage(SlackChannelEnum.GENERAL, message);
  }

  logFlowEvent({
    level: status === "ok" ? "info" : "error",
    flow: `reconciliation_${type}`,
    step: "daily",
    status: status === "ok" ? "completed" : "failed",
    runId,
    errorType: status === "error" ? "reconciliation_unsynced_orders" : undefined,
    errorMessage: status === "error" ? message : undefined,
    payload: {
      type,
      checkId,
      store: storeCode,
      dateFrom,
      dateTo,
      totalOrders: shopifyNames.length,
      unsyncedCount: unsyncedOrders.length,
      unsyncedOrders,
      unsyncedOrderIds,
      shopifyOrderCount: shopifyNames.length,
      dbRowsMatchedCount: dbByName.size,
      ...(type === "salesorder"
        ? {
            missingFromDbCount: salesorderMissingDbNames.length,
            missingFromDb: salesorderMissingDbNames,
          }
        : {}),
      ...(type === "gps_us" || type === "gps_uk"
        ? {
            gpsUnsyncedCount: gpsUnsyncedNames.length,
            gpsUnsyncedOrders: gpsUnsyncedNames,
          }
        : {}),
      ...(type === "fulfillment"
        ? {
            missingDbFulfillments,
            missingDbFulfillmentIds,
            missingShopifyFulfillments,
          }
        : {}),
    },
  });

  if (trace) {
    const unsyncedSample = unsyncedOrders.slice(0, 12);
    reconTrace(trace.runId, trace.type, "recon_done", {
      checkId,
      status,
      shopifyOrderCount: shopifyNames.length,
      dbRowsMatched: dbByName.size,
      unsyncedCount: unsyncedOrders.length,
      unsyncedSample: unsyncedSample.length > 0 ? unsyncedSample : undefined,
    });
  }

  return {
    type,
    checkId,
    dateFrom,
    dateTo,
    totalOrders: shopifyNames.length,
    matchedOrders: dbByName.size,
    unsyncedOrders,
    unsyncedOrderIds,
    ...(type === "fulfillment"
      ? { missingDbFulfillmentIds, missingDbFulfillments, missingShopifyFulfillments }
      : {}),
    status,
    message,
  };
}
