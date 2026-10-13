import { randomUUID } from "crypto";

import { queryDatabase } from "@/lib/db/database";
import { reconciliationHistoryQueries } from "@/lib/db/queries/reconciliation-history";

export type ReconciliationHistoryType = "salesorder" | "gps_us" | "gps_uk" | "fulfillment";

export async function startReconciliationHistory({
  runId,
  attempt,
  storeCode,
  type,
  triggerType,
  dateFrom,
  dateTo,
  windowStart,
  windowEndExclusive,
}: {
  runId: string;
  attempt: number;
  storeCode: string;
  type: ReconciliationHistoryType;
  triggerType: "cron" | "manual";
  dateFrom: string;
  dateTo: string;
  windowStart: string;
  windowEndExclusive: string;
}): Promise<string> {
  const result = await queryDatabase<{ audit_id: string }>(reconciliationHistoryQueries.start, [
    randomUUID(),
    runId,
    Math.max(1, attempt),
    storeCode,
    type,
    triggerType,
    dateFrom,
    dateTo,
    windowStart,
    windowEndExclusive,
  ]);
  const auditId = result.rows[0]?.audit_id;
  if (!auditId) throw new Error(`Could not start reconciliation history for ${type}`);
  return auditId;
}

export async function completeReconciliationHistory({
  auditId,
  status,
  totalOrders,
  matchedOrders,
  discrepancyCount,
  details,
  message,
  error,
}: {
  auditId: string;
  status: "passed" | "failed";
  totalOrders: number;
  matchedOrders: number;
  discrepancyCount: number;
  details: Record<string, unknown>;
  message?: string;
  error?: string;
}): Promise<void> {
  const result = await queryDatabase(reconciliationHistoryQueries.complete, [
    auditId,
    status,
    Math.max(0, totalOrders),
    Math.max(0, matchedOrders),
    Math.max(0, discrepancyCount),
    JSON.stringify(details),
    message ?? null,
    error ?? null,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`Reconciliation history ${auditId} is not running`);
  }
}
