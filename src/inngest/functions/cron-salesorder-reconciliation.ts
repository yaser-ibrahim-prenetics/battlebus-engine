// ============================================================================
// DAILY SALES ORDER RECONCILIATION
// ============================================================================
// Runs at 00:00 UTC and checks the previous *calendar day in America/New_York*
// (Shopify store time) for sync gaps. Hub/API date picks are YYYY-MM-DD in NY.
// 1) D365 SalesOrder reconciliation
// 2) GPS US SalesOrder reconciliation
// 3) GPS UK SalesOrder reconciliation

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

async function fetchShopifyPaidOrderNames(params: {
  dateFromIso: string;
  /** Exclusive end (UTC ISO): Shopify `created_at` uses `< this`. */
  dateEndExclusiveIso: string;
}): Promise<string[]> {
  const out: string[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const query = `
    query ReconciliationPaidOrders($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after, reverse: false, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            name
            cancelledAt
            displayFinancialStatus
          }
        }
        pageInfo {
          hasNextPage
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
            name?: string;
            cancelledAt?: string | null;
            displayFinancialStatus?: string | null;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean };
      };
    };
  };

  const dateFrom = params.dateFromIso.replace(".000Z", "Z");
  const dateEndExclusive = params.dateEndExclusiveIso.replace(".000Z", "Z");
  const shopifyQuery = `created_at:>=${dateFrom} created_at:<${dateEndExclusive} financial_status:paid`;

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
      out.push(name);
    }
    cursor = edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null;
    hasNextPage = Boolean(res?.data?.orders?.pageInfo?.hasNextPage && cursor);
  }

  return Array.from(new Set(out));
}

async function fetchShopifyFulfilledOrderNames(params: {
  dateFromIso: string;
  /** Exclusive end (UTC ISO) for `updated_at` upper bound. */
  dateEndExclusiveIso: string;
}): Promise<string[]> {
  const out: string[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const query = `
    query ReconciliationFulfilledOrders($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after, reverse: false, sortKey: UPDATED_AT) {
        edges {
          cursor
          node {
            name
            cancelledAt
            displayFulfillmentStatus
          }
        }
        pageInfo {
          hasNextPage
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
            name?: string;
            cancelledAt?: string | null;
            displayFulfillmentStatus?: string | null;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean };
      };
    };
  };

  const dateFrom = params.dateFromIso.replace(".000Z", "Z");
  const dateEndExclusive = params.dateEndExclusiveIso.replace(".000Z", "Z");
  const shopifyQuery = `updated_at:>=${dateFrom} updated_at:<${dateEndExclusive} fulfillment_status:fulfilled`;

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
      out.push(name);
    }
    cursor = edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null;
    hasNextPage = Boolean(res?.data?.orders?.pageInfo?.hasNextPage && cursor);
  }

  return Array.from(new Set(out));
}

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

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

/** Last closed calendar day in America/New_York (for the cron at 00:00 UTC). */
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

/** Inclusive `[fromYmd, toYmd]` in store TZ → UTC bounds for queries (`>= from`, `< endExclusive`). */
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

async function runOneRecon(params: {
  supabase: SupabaseClient;
  type: ReconType;
  dateFromIso: string;
  /** Exclusive end instant (UTC) for primary window; Supabase uses `< delayedTo` with delay slack. */
  dateEndExclusiveIso: string;
  dateFrom: string;
  dateTo: string;
  storeCode: string;
  runId: string;
}): Promise<ReconResult> {
  const { supabase, type, dateFromIso, dateEndExclusiveIso, dateFrom, dateTo, storeCode, runId } = params;
  const checkId = crypto.randomUUID();

  const delayedTo = new Date(
    new Date(dateEndExclusiveIso).getTime() + config.delays.orderSyncDelayMinutes * 60_000
  ).toISOString();

  // PostgREST / Supabase often enforces a per-response row cap (commonly 1000). A single
  // `.limit(4000)` can still return only the first page, which makes every other paid order
  // look "missing" from the DB and inflates `unsynced` false positives.
  const PAGE_SIZE = 1000;
  const rows: Array<
    OrderRow & { warehouse?: string | null; shopify_fulfillment_status?: string | null }
  > = [];
  let pageOffset = 0;
  let error: { message: string } | null = null;

  for (;;) {
    const { data, error: pageError } = await supabase
      .from("orders")
      .select(
        "shopify_order_name, d365_order_number, d365_sync_status, gps_order_no, gps_sync_status, shopify_fulfillment_status, warehouse"
      )
      .gte("created_at", dateFromIso)
      .lt("created_at", delayedTo)
      .eq("shopify_financial_status", "paid")
      .is("shopify_cancelled_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(pageOffset, pageOffset + PAGE_SIZE - 1);

    if (pageError) {
      error = pageError;
      break;
    }
    const batch = (data || []) as Array<
      OrderRow & { warehouse?: string | null; shopify_fulfillment_status?: string | null }
    >;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    pageOffset += PAGE_SIZE;
  }

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
      },
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

  const dbByName = new Map(
    rows
      .map((r) => [String(r.shopify_order_name || "").trim(), r] as const)
      .filter(([n]) => Boolean(n))
  );
  const shopifyPaidNames = await fetchShopifyPaidOrderNames({
    dateFromIso,
    dateEndExclusiveIso,
  });
  const missingInDb = shopifyPaidNames.filter((name) => !dbByName.has(name));

  let unsyncedOrders: string[] = [];
  /** Sales-order reconcile only: paid orders in Shopify with no matching `shopify_order_name` row in window. */
  let salesorderMissingDbNames: string[] = [];
  /** Sales-order reconcile only: row exists but D365 number/status incomplete. */
  let salesorderD365IncompleteNames: string[] = [];

  if (type === "salesorder") {
    salesorderD365IncompleteNames = Array.from(
      new Set(
        rows
          .filter(
            (r) =>
              !r.d365_order_number ||
              ["failed", "pending"].includes(String(r.d365_sync_status || "").toLowerCase())
          )
          .map((r) => String(r.shopify_order_name || "").trim())
          .filter(Boolean)
      )
    );
    salesorderMissingDbNames = [...missingInDb];
    unsyncedOrders = Array.from(
      new Set([...salesorderMissingDbNames, ...salesorderD365IncompleteNames])
    );
  } else if (type === "gps_us" || type === "gps_uk") {
    const wh = type === "gps_us" ? "GPS Warehouse" : "GPS UK Warehouse";
    const dbUnsynced = rows
      .filter((r) => String(r.warehouse || "") === wh)
      .filter(
        (r) =>
          !r.gps_order_no ||
          ["failed", "pending"].includes(String(r.gps_sync_status || "").toLowerCase())
      )
      .map((r) => String(r.shopify_order_name || "").trim())
      .filter(Boolean);
    // Keep Shopify-missing rows too; we cannot derive GPS-US/UK location reliably from Shopify query in this codebase.
    unsyncedOrders = Array.from(new Set([...missingInDb, ...dbUnsynced]));
  } else {
    const shopifyFulfilledNames = await fetchShopifyFulfilledOrderNames({
      dateFromIso,
      dateEndExclusiveIso: delayedTo,
    });
    const dbFulfilledNames = rows
      .filter(
        (r) => String(r.shopify_fulfillment_status || "").toLowerCase() === "fulfilled"
      )
      .map((r) => String(r.shopify_order_name || "").trim())
      .filter(Boolean);

    const missingDbFulfillments = shopifyFulfilledNames.filter(
      (name) => !dbFulfilledNames.includes(name)
    );
    const missingShopifyFulfillments = dbFulfilledNames.filter(
      (name) => !shopifyFulfilledNames.includes(name)
    );

    const errors: string[] = [];
    if (missingDbFulfillments.length > 0) {
      errors.push(
        `${missingDbFulfillments.length} orders fulfilled in Shopify but not in database:\n${missingDbFulfillments.join(
          "\n"
        )}`
      );
    }
    if (missingShopifyFulfillments.length > 0) {
      errors.push(
        `${missingShopifyFulfillments.length} orders fulfilled in database but not in Shopify:\n${missingShopifyFulfillments.join(
          "\n"
        )}`
      );
    }

    unsyncedOrders = Array.from(
      new Set([...missingDbFulfillments, ...missingShopifyFulfillments])
    );
    if (errors.length > 0) {
      const message = `Found fulfillment discrepancies for ${storeCode} store:\n${errors.join("\n")}`;
      const failMessage = `${typeLabel(type)}: Error for store ${storeCode} from ${dateFrom} to ${dateTo}:\n ${checkId}: ${message}`;
      await slack.sendErrorMessage(SlackChannelEnum.GENERAL, failMessage);
      logFlowEvent({
        level: "error",
        flow: `reconciliation_${type}`,
        step: "daily",
        status: "failed",
        runId,
        errorType: "reconciliation_unsynced_orders",
        errorMessage: failMessage,
        payload: {
          type,
          checkId,
          store: storeCode,
          dateFrom,
          dateTo,
          totalOrders: rows.length,
          unsyncedCount: unsyncedOrders.length,
          unsyncedOrders,
          missingDbFulfillments,
          missingShopifyFulfillments,
        },
      });
      return {
        type,
        checkId,
        dateFrom,
        dateTo,
        totalOrders: rows.length,
        unsyncedOrders,
        status: "error",
        message: failMessage,
      };
    }
  }

  const status: "ok" | "error" = unsyncedOrders.length === 0 ? "ok" : "error";
  const issueKindLabel =
    type === "salesorder"
      ? "issues (missing paid order row in DB and/or D365 sales order not fully synced)"
      : type === "gps_uk"
        ? "GPS UK orders missing in DB and/or GPS not fully synced"
        : type === "gps_us"
          ? "GPS US orders missing in DB and/or GPS not fully synced"
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
      totalOrders: rows.length,
      unsyncedCount: unsyncedOrders.length,
      unsyncedOrders,
      shopifyPaidOrderCount: shopifyPaidNames.length,
      ...(type === "salesorder"
        ? {
            missingFromDbCount: salesorderMissingDbNames.length,
            d365IncompleteOrderCount: salesorderD365IncompleteNames.length,
          }
        : {}),
    },
  });

  return {
    type,
    checkId,
    dateFrom,
    dateTo,
    totalOrders: rows.length,
    unsyncedOrders,
    status,
    message,
  };
}

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

