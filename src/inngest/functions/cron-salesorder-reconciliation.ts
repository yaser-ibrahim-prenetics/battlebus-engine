// ============================================================================
// DAILY SALES ORDER RECONCILIATION
// ============================================================================
// Runs at 00:00 UTC and checks previous UTC day orders for sync gaps:
// 1) D365 SalesOrder reconciliation
// 2) GPS US SalesOrder reconciliation
// 3) GPS UK SalesOrder reconciliation

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "../client";
import { config } from "@/lib/config";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { logFlowEvent, flushAll as flushFlowLogs } from "@/lib/services/supabase-flow-logs";

type ReconType = "salesorder" | "gps_us" | "gps_uk";

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

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getPreviousUtcDayRange(now: Date): { fromIso: string; toIso: string; fromDate: string; toDate: string } {
  const utcTodayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const utcYesterdayStart = new Date(utcTodayStart.getTime() - 24 * 60 * 60 * 1000);
  return {
    fromIso: utcYesterdayStart.toISOString(),
    toIso: utcTodayStart.toISOString(),
    fromDate: formatUtcDate(utcYesterdayStart),
    toDate: formatUtcDate(utcTodayStart),
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
  return "GPS UK SalesOrder Reconciliation";
}

async function runOneRecon(params: {
  supabase: SupabaseClient;
  type: ReconType;
  dateFromIso: string;
  dateToIso: string;
  dateFrom: string;
  dateTo: string;
  storeCode: string;
  runId: string;
}): Promise<ReconResult> {
  const { supabase, type, dateFromIso, dateToIso, dateFrom, dateTo, storeCode, runId } = params;
  const checkId = crypto.randomUUID();

  let query = supabase
    .from("orders")
    .select("shopify_order_name, d365_order_number, d365_sync_status, gps_order_no, gps_sync_status")
    .gte("created_at", dateFromIso)
    .lt("created_at", dateToIso)
    .eq("shopify_financial_status", "paid")
    .is("shopify_cancelled_at", null)
    .limit(2000);

  if (type === "gps_us") query = query.eq("warehouse", "GPS Warehouse");
  if (type === "gps_uk") query = query.eq("warehouse", "GPS UK Warehouse");

  const { data, error } = await query;
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

  const rows = (data || []) as OrderRow[];
  const unsyncedOrders = rows
    .filter((r) => {
      if (type === "salesorder") {
        return !r.d365_order_number || ["failed", "pending"].includes(String(r.d365_sync_status || "").toLowerCase());
      }
      return !r.gps_order_no || ["failed", "pending"].includes(String(r.gps_sync_status || "").toLowerCase());
    })
    .map((r) => String(r.shopify_order_name || "").trim())
    .filter(Boolean);

  const status: "ok" | "error" = unsyncedOrders.length === 0 ? "ok" : "error";
  const message =
    status === "ok"
      ? `${typeLabel(type)}: Order for store ${storeCode} from ${dateFrom} to ${dateTo}:\nAll orders are synced to DB.`
      : `${typeLabel(type)}: Error for store ${storeCode} from ${dateFrom} to ${dateTo}:\n ${checkId}: Found ${unsyncedOrders.length} unsynced ${
          type === "gps_uk" ? "GPS UK" : type === "gps_us" ? "GPS US" : "SalesOrder"
        } orders in database:\n${unsyncedOrders.join("\n")}`;

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
    triggers: [{ cron: "0 0 * * *" }],
    concurrency: { limit: 1 },
  },
  async ({ runId }: { runId?: string }) => {
    const supabase = getSupabaseClient();
    const storeCode = toStoreCode();
    const now = new Date();
    const { fromIso, toIso, fromDate, toDate } = getPreviousUtcDayRange(now);
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

    const results = await Promise.all([
      runOneRecon({
        supabase,
        type: "salesorder",
        dateFromIso: fromIso,
        dateToIso: toIso,
        dateFrom: fromDate,
        dateTo: toDate,
        storeCode,
        runId: safeRunId,
      }),
      runOneRecon({
        supabase,
        type: "gps_us",
        dateFromIso: fromIso,
        dateToIso: toIso,
        dateFrom: fromDate,
        dateTo: toDate,
        storeCode,
        runId: safeRunId,
      }),
      runOneRecon({
        supabase,
        type: "gps_uk",
        dateFromIso: fromIso,
        dateToIso: toIso,
        dateFrom: fromDate,
        dateTo: toDate,
        storeCode,
        runId: safeRunId,
      }),
    ]);

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

