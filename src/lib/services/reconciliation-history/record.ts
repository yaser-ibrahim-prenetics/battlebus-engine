import { randomUUID } from "node:crypto";
import { queryDatabase } from "@/lib/db/database";
import { beginAttemptSQL, finishAttemptSQL } from "@/lib/sql/reconciliation-history/attempts";

export interface ReconciliationContext {
  workflowRunId: string;
  kind:
    | "salesorder"
    | "gps_us"
    | "gps_uk"
    | "fulfillment"
    | "inventory"
    | "direct_salesorder"
    | "direct_fulfillment";
  scope: string;
  start?: string;
  end?: string;
}
export interface ReconciliationOutcome {
  status: "matched" | "discrepancies" | "failed" | "skipped";
  // Callers must select safe fields; never persist provider errors or customer payloads.
  result: Record<string, unknown>;
  errorCode?: string;
}

/** Each retry is a separate attempt. Crashes remain running and are detectable by age. */
export async function recordReconciliation<T>(
  context: ReconciliationContext,
  execute: () => Promise<T>,
  summarize: (value: T) => ReconciliationOutcome
): Promise<T> {
  const id = randomUUID();
  const created = await queryDatabase(beginAttemptSQL, [
    id,
    context.workflowRunId,
    context.kind,
    context.scope,
    context.start ?? null,
    context.end ?? null,
  ]);
  if (created.rowCount !== 1) throw new Error("Reconciliation attempt could not be recorded");
  try {
    const value = await execute();
    const outcome = summarize(value);
    const saved = await queryDatabase(finishAttemptSQL, [
      id,
      outcome.status,
      JSON.stringify(outcome.result),
      outcome.errorCode ?? null,
    ]);
    if (saved.rowCount !== 1) throw new Error("Reconciliation completion could not be recorded");
    return value;
  } catch (error) {
    await queryDatabase(finishAttemptSQL, [id, "failed", null, "provider_or_persistence_failure"]);
    throw error;
  }
}
