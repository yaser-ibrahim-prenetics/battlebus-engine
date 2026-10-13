import crypto from "crypto";
import { inngest } from "../client";
import { config } from "@/lib/config";
import { isDatabaseConfigured } from "@/lib/db/database";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { logFlowEvent, flushAll as flushFlowLogs } from "@/lib/services/flow-logs";
import {
  completeReconciliationHistory,
  startReconciliationHistory,
} from "@/lib/services/reconciliation-history";
import { getPreviousUtcDayRange, utcInclusiveRangeToUtcBounds } from "./cron-salesorder-reconciliation/date-range";
import { toStoreCode } from "./cron-salesorder-reconciliation/helpers";
import { runOneRecon } from "./cron-salesorder-reconciliation/run-reconciliation";
import type { ReconResult, ReconType } from "./cron-salesorder-reconciliation/types";

export const cronSalesorderReconciliation = inngest.createFunction(
  {
    id: "cron-salesorder-reconciliation",
    name: "Daily SalesOrder Reconciliation",
    triggers: [{ cron: "0 0 * * *" }, { event: "reconciliation/run" }],
    concurrency: { limit: 1 },
  },
  async ({ event, runId, attempt }: { event?: any; runId?: string; attempt?: number }) => {
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
      ? utcInclusiveRangeToUtcBounds(manualFrom, manualTo)
      : getPreviousUtcDayRange(new Date());
    const { fromIso, dateEndExclusiveIso, fromDate, toDate } = computed;
    const safeRunId = String(runId || crypto.randomUUID());
    // Inngest exposes a zero-based retry attempt; persist it as a human-readable one-based value.
    const safeAttempt = Math.max(1, Number(attempt ?? 0) + 1);
    const triggerType = eventType === "reconciliation/run" ? "manual" : "cron";

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

    if (!isDatabaseConfigured()) {
      const message = `SalesOrder Reconciliation: Error for store ${storeCode} from ${fromDate} to ${toDate}:\n PostgreSQL is not configured.`;
      await slack.sendErrorMessage(SlackChannelEnum.GENERAL, message);
      logFlowEvent({
        level: "error",
        flow: "reconciliation_salesorder",
        step: "daily",
        status: "failed",
        runId: safeRunId || undefined,
        errorType: "reconciliation_database_not_configured",
        errorMessage: message,
        payload: {
          type: "salesorder",
          store: storeCode,
          dateFrom: fromDate,
          dateTo: toDate,
        },
      });
      await flushFlowLogs();
      return { status: "failed", reason: "database_not_configured" };
    }

    const types: ReconType[] =
      requestedType === "all" ? ["salesorder", "gps_us", "gps_uk", "fulfillment"] : [requestedType];
    const results: ReconResult[] = [];
    for (const type of types) {
      // Keep deterministic per-check order in run result payload and modal rendering.
      const auditId = await startReconciliationHistory({
        runId: safeRunId,
        attempt: safeAttempt,
        storeCode,
        type,
        triggerType,
        dateFrom: fromDate,
        dateTo: toDate,
        windowStart: fromIso,
        windowEndExclusive: dateEndExclusiveIso,
      });

      try {
        const item = await runOneRecon({
          type,
          dateFromIso: fromIso,
          dateEndExclusiveIso,
          dateFrom: fromDate,
          dateTo: toDate,
          storeCode,
          runId: safeRunId,
        });
        await completeReconciliationHistory({
          auditId,
          status: item.status === "ok" ? "passed" : "failed",
          totalOrders: item.totalOrders,
          matchedOrders: item.matchedOrders,
          discrepancyCount: item.unsyncedOrders.length,
          details: {
            checkId: item.checkId,
            unsyncedOrders: item.unsyncedOrders,
            unsyncedOrderIds: item.unsyncedOrderIds,
            missingDbFulfillments: item.missingDbFulfillments || [],
            missingDbFulfillmentIds: item.missingDbFulfillmentIds || [],
            missingShopifyFulfillments: item.missingShopifyFulfillments || [],
          },
          message: item.message,
          error: item.status === "error" ? item.message : undefined,
        });
        results.push(item);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await completeReconciliationHistory({
          auditId,
          status: "failed",
          totalOrders: 0,
          matchedOrders: 0,
          discrepancyCount: 0,
          details: { checkId: auditId, phase: "unhandled_error" },
          error: errorMessage,
        }).catch((historyError) => {
          console.error("[Reconciliation] Failed to finalize history", historyError);
        });
        throw error;
      }
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

