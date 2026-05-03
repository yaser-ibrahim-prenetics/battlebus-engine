// ============================================================================
// DAILY SALES ORDER RECONCILIATION
// ============================================================================
// Strategy (per-type):
//
//   - SALESORDER: Pull paid orders from Shopify in the window. Look them up in
//     DB by `shopify_order_name`. Unsynced = names not in DB.
//
//   - GPS_US / GPS_UK: Pull paid orders from Shopify in the window. Look them
//     up in DB. Unsynced = DB rows whose `warehouse` matches the GPS warehouse
//     AND (missing `gps_order_no` for US / `gps_uk_order_no` for UK, OR
//     `gps_sync_status` is `failed` — i.e. GPS outbound did not succeed).
//
//   - FULFILLMENT: Pull ALL orders from Shopify in the window with their
//     fulfillment status. Look them up in DB. Two buckets:
//       a) Fulfilled in Shopify, not fulfilled in DB (or row missing).
//       b) Fulfilled in DB, not fulfilled in Shopify.
//
// Shopify order windowing uses Admin GraphQL `orders(query: ...)` plus a strict check on each
// `createdAt`: keep only orders in `[store midnight dateFrom, store midnight dayAfterTo)` so the
// search bar cannot pull in the next/previous civil day (e.g. Apr 30 orders when reconciling Apr 29).
//
// We never filter the DB by `created_at` for matching — Supabase `created_at` is row insert time.
// Manual trigger: `event = "reconciliation/run"` with
//   `data: { type, dateFrom, dateTo }` (YYYY-MM-DD in store TZ).
// Cron: 00:00 UTC daily, reconciles previous closed store-TZ calendar day.
//
// Logging:
//   • Every run emits one-line JSON on stdout with tag "reconciliation" (grep in Vercel / Inngest logs).
//   • Set RECONCILIATION_VERBOSE_LOG=1 on Battle Bus to also write flow_logs with flow=reconciliation_trace
//     (per-Shopify page + per-Supabase batch detail).
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addDays, format } from "date-fns";
import { formatInTimeZone, toDate } from "date-fns-tz";
import { inngest } from "../client";
import { config } from "@/lib/config";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { logFlowEvent, flushAll as flushFlowLogs } from "@/lib/services/supabase-flow-logs";
import { shopifyAdminGraphql } from "@/lib/clients/shopify";

type ReconType = "salesorder" | "gps_us" | "gps_uk" | "fulfillment";

type OrderRow = {
  shopify_order_name: string | null;
  d365_order_number: string | null;
  d365_sync_status: string | null;
  gps_order_no: string | null;
  gps_uk_order_no: string | null;
  gps_sync_status: string | null;
  shopify_financial_status: string | null;
  shopify_cancelled_at: string | null;
  shopify_fulfillment_status: string | null;
  warehouse: string | null;
};

type ShopifyWindowOrder = {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  totalPrice: string | null;
};

type ReconResult = {
  type: ReconType;
  checkId: string;
  dateFrom: string;
  dateTo: string;
  totalOrders: number;
  unsyncedOrders: string[];
  unsyncedOrderIds: string[];
  missingDbFulfillmentIds?: string[];
  status: "ok" | "error";
  message: string;
};

/** Structured stdout + optional flow_logs (`reconciliation_trace`) when `RECONCILIATION_VERBOSE_LOG` is set. */
function reconTrace(
  runId: string,
  reconType: ReconType,
  phase: string,
  data: Record<string, unknown>
): void {
  const line = {
    tag: "reconciliation",
    at: new Date().toISOString(),
    runId: runId || undefined,
    reconType,
    phase,
    ...data,
  };
  console.log(JSON.stringify(line));
  if (config.reconciliation.verboseLog && runId) {
    logFlowEvent({
      level: "info",
      flow: "reconciliation_trace",
      step: phase,
      status: "running",
      runId,
      payload: { reconType, ...data },
    });
  }
}

// ---------------------------------------------------------------------------
// Date helpers (store-TZ-aware)
// ---------------------------------------------------------------------------

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const parts = ymd.split("-").map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  }
  const [y, m, d] = parts;
  const cal = new Date(Date.UTC(y, m - 1, d));
  return format(addDays(cal, deltaDays), "yyyy-MM-dd");
}

/** Civil midnight on `ymd` in the store TZ → UTC instant as ISO string. */
function storeMidnightUtcIso(ymd: string): string {
  return toDate(`${ymd}T00:00:00`, { timeZone: config.reconciliation.storeTimeZone }).toISOString();
}

/**
 * True if Shopify's order {@link createdAtIso} falls in the half-open window
 * `[start of fromYmd, start of beforeYmd)` in {@link config.reconciliation.storeTimeZone}.
 * `beforeYmd` must be the exclusive end date (e.g. 2026-04-30 when the last included day is 2026-04-29).
 *
 * The GraphQL `orders(query: "created_at:…")` filter can return orders outside this civil window;
 * we always enforce the intended range using the API's `createdAt` field.
 */
function orderCreatedAtInStoreHalfOpenWindow(
  createdAtIso: string,
  fromYmd: string,
  beforeYmd: string
): boolean {
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return false;
  const startMs = Date.parse(storeMidnightUtcIso(fromYmd));
  const endMs = Date.parse(storeMidnightUtcIso(beforeYmd));
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  return t >= startMs && t < endMs;
}

/** Last closed calendar day in store TZ (for the cron at 00:00 UTC). */
function getPreviousStoreDayRange(now: Date): {
  fromIso: string;
  dateEndExclusiveIso: string;
  fromDate: string;
  toDate: string;
} {
  const todayYmd = formatInTimeZone(now, config.reconciliation.storeTimeZone, "yyyy-MM-dd");
  const yesterdayYmd = addCalendarDaysYmd(todayYmd, -1);
  return {
    fromIso: storeMidnightUtcIso(yesterdayYmd),
    dateEndExclusiveIso: storeMidnightUtcIso(todayYmd),
    fromDate: yesterdayYmd,
    toDate: yesterdayYmd,
  };
}

/** Inclusive `[fromYmd, toYmd]` in store TZ → UTC bounds. */
function storeInclusiveRangeToUtcBounds(fromYmd: string, toYmd: string): {
  fromIso: string;
  dateEndExclusiveIso: string;
  fromDate: string;
  toDate: string;
} {
  const dayAfterTo = addCalendarDaysYmd(toYmd, 1);
  return {
    fromIso: storeMidnightUtcIso(fromYmd),
    dateEndExclusiveIso: storeMidnightUtcIso(dayAfterTo),
    fromDate: fromYmd,
    toDate: toYmd,
  };
}

// ---------------------------------------------------------------------------
// Shopify queries
// ---------------------------------------------------------------------------

/**
 * Pull orders from Shopify for civil dates [{@link createdAtFromYmd}, {@link createdAtBeforeYmd})
 * in the **store timezone**.
 * The `query` string pre-filters in Shopify; each order is then kept only if {@link orderCreatedAtInStoreHalfOpenWindow}
 * passes (GraphQL `createdAt` vs store midnights), because search can return neighbors outside the intended day.
 */
async function fetchShopifyWindowOrders(params: {
  createdAtFromYmd: string;
  /** Exclusive end calendar day as YYYY-MM-DD in store TZ (first day not included). */
  createdAtBeforeYmd: string;
  extraQuery?: string;
  trace?: { runId: string; type: ReconType };
}): Promise<ShopifyWindowOrder[]> {
  const items: ShopifyWindowOrder[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageIndex = 0;
  let skippedOutsideCreatedAtWindow = 0;

  const query = `
    query ReconciliationWindowOrders($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after, reverse: false, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  type ShopifyOrdersQueryResponse = {
    data?: {
      orders?: {
        edges?: Array<{
          cursor?: string;
          node?: {
            id?: string;
            name?: string;
            createdAt?: string | null;
            cancelledAt?: string | null;
            displayFinancialStatus?: string | null;
            displayFulfillmentStatus?: string | null;
            totalPriceSet?: {
              shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
            } | null;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };

  const { createdAtFromYmd, createdAtBeforeYmd } = params;
  const baseQuery = `created_at:>=${createdAtFromYmd} created_at:<${createdAtBeforeYmd}`;
  const shopifyQuery = params.extraQuery ? `${baseQuery} ${params.extraQuery}` : baseQuery;

  const { trace } = params;
  if (trace) {
    reconTrace(trace.runId, trace.type, "shopify_window_start", {
      shopifyQuery,
      createdAtFromYmd,
      createdAtBeforeYmd,
      storeTimeZone: config.reconciliation.storeTimeZone,
      extraQuery: params.extraQuery ?? null,
    });
  }

  while (hasNextPage) {
    pageIndex += 1;
    const res: ShopifyOrdersQueryResponse = await shopifyAdminGraphql<ShopifyOrdersQueryResponse>(query, {
      query: shopifyQuery,
      after: cursor,
    });

    const edges = res?.data?.orders?.edges || [];
    const pageInfo = res?.data?.orders?.pageInfo;
    if (trace && config.reconciliation.verboseLog) {
      reconTrace(trace.runId, trace.type, "shopify_window_page", {
        page: pageIndex,
        edgeCount: edges.length,
        hasNextPage: Boolean(pageInfo?.hasNextPage),
      });
    }
    for (const edge of edges) {
      const name = String(edge?.node?.name || "").trim();
      if (!name) continue;
      if (edge?.node?.cancelledAt) continue;
      const createdAt = String(edge?.node?.createdAt || "").trim();
      if (!orderCreatedAtInStoreHalfOpenWindow(createdAt, createdAtFromYmd, createdAtBeforeYmd)) {
        skippedOutsideCreatedAtWindow += 1;
        continue;
      }
      const amount = edge?.node?.totalPriceSet?.shopMoney?.amount;
      items.push({
        id: String(edge?.node?.id || ""),
        name,
        createdAt,
        financialStatus: String(edge?.node?.displayFinancialStatus || "").toUpperCase(),
        fulfillmentStatus: String(edge?.node?.displayFulfillmentStatus || "").toUpperCase(),
        totalPrice: amount != null && amount !== "" ? String(amount) : null,
      });
    }
    const endCursor = pageInfo?.endCursor || (edges.length > 0 ? edges[edges.length - 1]?.cursor : null) || null;
    cursor = endCursor;
    hasNextPage = Boolean(pageInfo?.hasNextPage && cursor);
  }

  // Dedupe by name (keep latest createdAt if duplicates).
  const byName = new Map<string, ShopifyWindowOrder>();
  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev || (it.createdAt && it.createdAt > (prev.createdAt || ""))) {
      byName.set(it.name, it);
    }
  }
  const unique = Array.from(byName.values());
  if (trace) {
    const sorted = unique.map((o) => o.name).sort();
    const head = sorted.slice(0, 8);
    const tail = sorted.length > 16 ? sorted.slice(-8) : [];
    reconTrace(trace.runId, trace.type, "shopify_window_done", {
      pages: pageIndex,
      rowsRaw: items.length,
      graphQLEdgesSkippedWrongCreatedAt: skippedOutsideCreatedAtWindow,
      uniqueOrderCount: unique.length,
      sampleNamesStart: head,
      sampleNamesEnd: tail.length ? tail : undefined,
    });
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Look up rows by `shopify_order_name`. Batched to keep `IN (…)` short. */
async function fetchOrderRowsByName(
  supabase: SupabaseClient,
  names: string[],
  trace?: { runId: string; type: ReconType }
): Promise<{ rows: OrderRow[]; error: { message: string } | null }> {
  const out: OrderRow[] = [];
  if (names.length === 0) return { rows: out, error: null };

  const BATCH = 200;
  const seen = new Set<string>();
  let batchIdx = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    batchIdx += 1;
    const batchNames = names.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("orders")
      .select(
        "shopify_order_name, d365_order_number, d365_sync_status, gps_order_no, gps_uk_order_no, gps_sync_status, shopify_financial_status, shopify_cancelled_at, shopify_fulfillment_status, warehouse"
      )
      .in("shopify_order_name", batchNames);
    if (trace && !error && config.reconciliation.verboseLog) {
      reconTrace(trace.runId, trace.type, "supabase_orders_in_batch", {
        batch: batchIdx,
        namesInBatch: batchNames.length,
        rowsReturned: (data || []).length,
      });
    }
    if (error) return { rows: out, error };
    for (const r of (data || []) as OrderRow[]) {
      const key = String(r.shopify_order_name || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  if (trace) {
    reconTrace(trace.runId, trace.type, "supabase_orders_done", {
      namesRequested: names.length,
      uniqueRows: out.length,
      batches: batchIdx,
    });
  }
  return { rows: out, error: null };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function toStoreCode(): string {
  const fromEnv = process.env.RECONCILIATION_STORE_CODE?.trim();
  if (fromEnv) return fromEnv;
  const domain = config.shopify.im8.shopDomain || "";
  if (!domain) return "im8";
  return domain.split(".")[0] || "im8";
}

function typeLabel(t: ReconType): string {
  if (t === "salesorder") return "SalesOrder Reconciliation";
  if (t === "gps_us") return "GPS SalesOrder Reconciliation";
  if (t === "fulfillment") return "Fulfillment Reconciliation";
  return "GPS UK SalesOrder Reconciliation";
}

function extractShopifyOrderId(orderId: string): string | null {
  const raw = String(orderId || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/\/(\d+)\s*$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Per-recon-type orchestration
// ---------------------------------------------------------------------------

async function runOneRecon(params: {
  supabase: SupabaseClient;
  type: ReconType;
  dateFromIso: string;
  /** Exclusive end instant (UTC) for the Shopify window. */
  dateEndExclusiveIso: string;
  dateFrom: string;
  dateTo: string;
  storeCode: string;
  runId: string;
}): Promise<ReconResult> {
  const { supabase, type, dateFromIso, dateEndExclusiveIso, dateFrom, dateTo, storeCode, runId } = params;
  const checkId = crypto.randomUUID();
  const trace = runId ? { runId, type } : undefined;
  const createdAtBeforeYmd = addCalendarDaysYmd(dateTo, 1);

  if (trace) {
    reconTrace(trace.runId, trace.type, "recon_start", {
      checkId,
      storeCode,
      dateFrom,
      dateTo,
      shopifyCreatedAtFromYmd: dateFrom,
      shopifyCreatedAtBeforeYmd: createdAtBeforeYmd,
      storeTimeZone: config.reconciliation.storeTimeZone,
      dateFromIso,
      dateEndExclusiveIso,
    });
  }

  // Step 1 — Pull orders via Admin GraphQL `orders` + search `query` (store-TZ date bounds).
  // SalesOrder + GPS: paid only. Fulfillment: all orders in the window (for status cross-check).
  const extraQuery = type === "fulfillment" ? undefined : "financial_status:paid";
  const shopifyOrders = await fetchShopifyWindowOrders({
    createdAtFromYmd: dateFrom,
    createdAtBeforeYmd,
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
  const { rows, error } = await fetchOrderRowsByName(supabase, shopifyNames, trace);

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
      payload: { type, checkId, store: storeCode, dateFrom, dateTo, shopifyOrderCount: shopifyNames.length },
    });
    if (trace) {
      reconTrace(trace.runId, trace.type, "recon_failed", {
        checkId,
        stage: "supabase_orders",
        error: error.message,
      });
    }
    return {
      type,
      checkId,
      dateFrom,
      dateTo,
      totalOrders: 0,
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
  let gpsUnsyncedNames: string[] = [];
  /** Fulfillment recon: fulfilled in Shopify, not fulfilled in DB (or row missing). */
  let missingDbFulfillments: string[] = [];
  let missingDbFulfillmentIds: string[] = [];
  /** Fulfillment recon: fulfilled in DB, not fulfilled in Shopify. */
  let missingShopifyFulfillments: string[] = [];

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
      const gpsOrderNoForWarehouse =
        type === "gps_uk" ? r.gps_uk_order_no : r.gps_order_no;
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
    unsyncedOrders = Array.from(
      new Set([...missingDbFulfillments, ...missingShopifyFulfillments])
    );
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
    unsyncedOrders,
    unsyncedOrderIds,
    ...(type === "fulfillment" ? { missingDbFulfillmentIds } : {}),
    status,
    message,
  };
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

export const cronSalesorderReconciliation = inngest.createFunction(
  {
    id: "cron-salesorder-reconciliation",
    name: "Daily SalesOrder Reconciliation",
    triggers: [{ cron: "0 0 * * *" }, { event: "reconciliation/run" }],
    concurrency: { limit: 1 },
  },
  async ({ event, runId }: { event?: any; runId?: string }) => {
    const supabase = getSupabaseClient();
    const storeCode = toStoreCode();
    const eventType = String(event?.name || "");
    const requestedType = String(event?.data?.type || "all") as
      | "all"
      | "salesorder"
      | "gps_us"
      | "gps_uk"
      | "fulfillment";
    const manualFrom = String(event?.data?.dateFrom || "").trim();
    const manualTo = String(event?.data?.dateTo || "").trim();
    const hasManualRange = eventType === "reconciliation/run" && manualFrom && manualTo;
    const computed = hasManualRange
      ? storeInclusiveRangeToUtcBounds(manualFrom, manualTo)
      : getPreviousStoreDayRange(new Date());
    const { fromIso, dateEndExclusiveIso, fromDate, toDate } = computed;
    const safeRunId = String(runId || "");

    console.log(
      JSON.stringify({
        tag: "reconciliation",
        phase: "cron_invoke",
        at: new Date().toISOString(),
        runId: safeRunId || undefined,
        storeCode,
        requestedType,
        dateFrom: fromDate,
        dateTo: toDate,
        fromIso,
        dateEndExclusiveIso,
        verboseFlowLogs: config.reconciliation.verboseLog,
      })
    );

    if (!supabase) {
      const message = `SalesOrder Reconciliation: Error for store ${storeCode} from ${fromDate} to ${toDate}:\n Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).`;
      await slack.sendErrorMessage(SlackChannelEnum.GENERAL, message);
      logFlowEvent({
        level: "error",
        flow: "reconciliation_salesorder",
        step: "daily",
        status: "failed",
        runId: safeRunId || undefined,
        errorType: "reconciliation_supabase_not_configured",
        errorMessage: message,
        payload: {
          type: "salesorder",
          store: storeCode,
          dateFrom: fromDate,
          dateTo: toDate,
        },
      });
      await flushFlowLogs();
      return { status: "failed", reason: "supabase_not_configured" };
    }

    const types: ReconType[] =
      requestedType === "all"
        ? ["salesorder", "gps_us", "gps_uk", "fulfillment"]
        : [requestedType];
    const results: ReconResult[] = [];
    for (const type of types) {
      // Keep deterministic per-check order in run result payload and modal rendering.
      // eslint-disable-next-line no-await-in-loop
      const item = await runOneRecon({
        supabase,
        type,
        dateFromIso: fromIso,
        dateEndExclusiveIso,
        dateFrom: fromDate,
        dateTo: toDate,
        storeCode,
        runId: safeRunId,
      });
      results.push(item);
    }

    await flushFlowLogs();

    return {
      status: "completed",
      dateFrom: fromDate,
      dateTo: toDate,
      store: storeCode,
      results,
    };
  }
);
