type Result = Record<string, unknown>;
export type WorkflowOutcome = "completed" | "failed" | "skipped";

const record = (value: unknown): Result =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Result) : {};
const nonemptyErrors = (value: unknown) =>
  (typeof value === "number" && value > 0) || (Array.isArray(value) && value.length > 0);

function failed(value: unknown): boolean {
  const result = record(value);
  return (
    result.success === false ||
    ["failed", "error", "exhausted"].includes(String(result.status)) ||
    nonemptyErrors(result.errors)
  );
}

/** Inspect known result envelopes, never recursively interpret provider/customer payloads. */
export function classifyWorkflowOutcome(functionId: string, output: unknown): WorkflowOutcome {
  const result = record(output);
  // An explicitly skipped/disabled invocation is not evidence of a business attempt.
  if (
    result.skipped === true ||
    result.dryRun === true ||
    ["skipped", "disabled", "dry_run", "deferred", "awaiting_order", "holding"].includes(
      String(result.status)
    )
  ) {
    return "skipped";
  }
  if (failed(result)) return "failed";

  switch (functionId) {
    case "cron-salesorder-reconciliation":
      if (!Array.isArray(result.results) || result.results.some(failed)) return "failed";
      break;
    case "cron-inventory-reconciliation": {
      const summary = record(result.summary);
      if (
        nonemptyErrors(summary.totalErrors) ||
        nonemptyErrors(summary.failedSyncs) ||
        (Array.isArray(result.details) && result.details.some(failed))
      )
        return "failed";
      break;
    }
    case "trigger-inventory-reconciliation": {
      const reconciliation = record(result.reconciliation);
      if (
        failed(reconciliation) ||
        (Array.isArray(reconciliation.syncActions) && reconciliation.syncActions.some(failed))
      )
        return "failed";
      break;
    }
    case "sync-sku-inventory":
      if ([result.result, result.gpsToD365, result.d365ToShopify].some(failed)) return "failed";
      break;
    case "process-refund":
      if (result.invoiceResult === "error") return "failed";
      break;
    case "process-backorder":
      if (
        ["still_backorder", "parked_manual_only", "parked_no_retry"].includes(String(result.status))
      )
        return "failed";
      break;
  }
  return "completed";
}
