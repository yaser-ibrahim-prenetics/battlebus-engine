// ============================================================================
// DAILY SALES ORDER RECONCILIATION
// ============================================================================
// Strategy (per-type):
//
//   - SALESORDER: Pull paid orders from Shopify in the window. Look them up in
//     DB by `shopify_order_name`. Unsynced = names not in DB.
//
//   - GPS_US / GPS_UK: Pull paid orders from Shopify in the window. Look them
//     up in DB. Unsynced = DB rows whose `warehouse` matches the GPS location
//     AND `gps_order_no` is missing (or `gps_sync_status` is failed/pending).
//
//   - FULFILLMENT: Pull ALL orders from Shopify in the window with their
//     fulfillment status. Look them up in DB. Two buckets:
//       a) Fulfilled in Shopify, not fulfilled in DB (or row missing).
//       b) Fulfilled in DB, not fulfilled in Shopify.
//
// We never filter the DB by `created_at` — Supabase's `created_at` is the row
// insert time (often slightly after Shopify). All windowing is done on the
// Shopify side.
//
// Manual trigger: `event = "reconciliation/run"` with
//   `data: { type, dateFrom, dateTo }` (YYYY-MM-DD in store TZ).
// Cron: 00:00 UTC daily, reconciles previous closed store-TZ calendar day.
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
  gps_sync_status: string | null;
  shopify_financial_status: string | null;
  shopify_cancelled_at: string | null;
  shopify_fulfillment_status: string | null;
  warehouse: string | null;
};

type ShopifyWindowOrder = {
  name: string;
  financialStatus: string;
  fulfillmentStatus: string;
};

type ReconResult = {
  type: ReconType;
  checkId: string;
  dateFrom: string;
  dateTo: string;
  totalOrders: number;
  unsyncedOrders: string[];
  status: "ok" | "error";
  message: string;
};

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
 * Pull orders from Shopify in `[fromIso, endExclusiveIso)` (UTC).
 * `extraQuery` lets callers add Shopify search qualifiers (e.g. `financial_status:paid`).
 */
async function fetchShopifyWindowOrders(params: {
  dateFromIso: string;
  dateEndExclusiveIso: string;
  extraQuery?: string;
}): Promise<ShopifyWindowOrder[]> {
  const items: ShopifyWindowOrder[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const query = `
    query ReconciliationWindowOrders($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after, reverse: false, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            name
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  type ShopifyOrdersQueryResponse = {
    data?: {
      orders?: {
        edges?: Array<{
          cursor?: string;
          node?: {
            name?: string;
            cancelledAt?: string | null;
            displayFinancialStatus?: string | null;
            displayFulfillmentStatus?: string | null;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean };
      };
    };
  };

  const dateFrom = params.dateFromIso.replace(".000Z", "Z");
  const dateEndExclusive = params.dateEndExclusiveIso.replace(".000Z", "Z");
  const baseQuery = `created_at:>=${dateFrom} created_at:<${dateEndExclusive}`;
  const shopifyQuery = params.extraQuery ? `${baseQuery} ${params.extraQuery}` : baseQuery;

  while (hasNextPage) {
    const res: ShopifyOrdersQueryResponse = await shopifyAdminGraphql<ShopifyOrdersQueryResponse>(query, {
      query: shopifyQuery,
      after: cursor,
    });

    const edges = res?.data?.orders?.edges || [];
    for (const edge of edges) {
      const name = String(edge?.node?.name || "").trim();
      if (!name) continue;
      if (edge?.node?.cancelledAt) continue;
      items.push({
        name,
        financialStatus: String(edge?.node?.displayFinancialStatus || "").toUpperCase(),
        fulfillmentStatus: String(edge?.node?.displayFulfillmentStatus || "").toUpperCase(),
      });
    }
    cursor = edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null;
    hasNextPage = Boolean(res?.data?.orders?.pageInfo?.hasNextPage && cursor);
  }

  // Dedupe by name (Shopify shouldn't return duplicates, but be safe).
  const byName = new Map<string, ShopifyWindowOrder>();
  for (const it of items) byName.set(it.name, it);
  return Array.from(byName.values());
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
  names: string[]
): Promise<{ rows: OrderRow[]; error: { message: string } | null }> {
  const out: OrderRow[] = [];
  if (names.length === 0) return { rows: out, error: null };

  const BATCH = 200;
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i += BATCH) {
    const batchNames = names.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("orders")
      .select(
        "shopify_order_name, d365_order_number, d365_sync_status, gps_order_no, gps_sync_status, shopify_financial_status, shopify_cancelled_at, shopify_fulfillment_status, warehouse"
      )
      .in("shopify_order_name", batchNames);
    if (error) return { rows: out, error };
    for (const r of (data || []) as OrderRow[]) {
      const key = String(r.shopify_order_name || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
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

  // Step 1 — Pull Shopify orders for the window, with status info.
  // SalesOrder + GPS recons only care about paid orders.
  // Fulfillment recon needs everything to detect bidirectional discrepancies.
  const extraQuery = type === "fulfillment" ? undefined : "financial_status:paid";
  const shopifyOrders = await fetchShopifyWindowOrders({
    dateFromIso,
    dateEndExclusiveIso,
    extraQuery,
  });
  const shopifyNames = shopifyOrders.map((o) => o.name);

  // Step 2 — Look those names up in DB by name. No `created_at` filter.
  const { rows, error } = await fetchOrderRowsByName(supabase, shopifyNames);

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
    return {
      type,
      checkId,
      dateFrom,
      dateTo,
      totalOrders: 0,
      unsyncedOrders: [],
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
  let salesorderMissingDbNames: string[] = [];
  /** GPS recons: DB row exists, warehouse matches, but GPS sync incomplete. */
  let gpsUnsyncedNames: string[] = [];
  /** Fulfillment recon: fulfilled in Shopify, not fulfilled in DB (or row missing). */
  let missingDbFulfillments: string[] = [];
  /** Fulfillment recon: fulfilled in DB, not fulfilled in Shopify. */
  let missingShopifyFulfillments: string[] = [];

  if (type === "salesorder") {
    salesorderMissingDbNames = shopifyNames.filter((n) => !dbByName.has(n));
    unsyncedOrders = [...salesorderMissingDbNames];
  } else if (type === "gps_us" || type === "gps_uk") {
    const wh = type === "gps_us" ? "GPS Warehouse" : "GPS UK Warehouse";
    for (const name of shopifyNames) {
      const r = dbByName.get(name);
      if (!r) continue; // missing-row is salesorder recon's concern, not GPS.
      if (String(r.warehouse || "") !== wh) continue;
      const gpsStatus = String(r.gps_sync_status || "").toLowerCase();
      if (!r.gps_order_no || ["failed", "pending"].includes(gpsStatus)) {
        gpsUnsyncedNames.push(name);
      }
    }
    unsyncedOrders = Array.from(new Set(gpsUnsyncedNames));
  } else {
    // fulfillment
    for (const o of shopifyOrders) {
      const shopifyFulfilled = o.fulfillmentStatus === "FULFILLED";
      const r = dbByName.get(o.name);
      const dbFulfilled =
        !!r && String(r.shopify_fulfillment_status || "").toLowerCase() === "fulfilled";
      if (shopifyFulfilled && !dbFulfilled) {
        missingDbFulfillments.push(o.name);
      } else if (!shopifyFulfilled && dbFulfilled) {
        missingShopifyFulfillments.push(o.name);
      }
    }
    unsyncedOrders = Array.from(
      new Set([...missingDbFulfillments, ...missingShopifyFulfillments])
    );
  }

  // Step 3 — Compose status, log, and notify.
  const status: "ok" | "error" = unsyncedOrders.length === 0 ? "ok" : "error";
  const issueKindLabel =
    type === "salesorder"
      ? "paid order(s) present in Shopify but missing in DB"
      : type === "gps_uk"
        ? "GPS UK orders missing GPS order id in DB"
        : type === "gps_us"
          ? "GPS US orders missing GPS order id in DB"
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
            missingShopifyFulfillments,
          }
        : {}),
    },
  });

  return {
    type,
    checkId,
    dateFrom,
    dateTo,
    totalOrders: shopifyNames.length,
    unsyncedOrders,
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
