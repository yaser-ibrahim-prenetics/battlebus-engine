import { expect, it } from "vitest";
import { classifyWorkflowOutcome as classify } from "../workflow-outcome";

it.each([
  ["cron-gps-sync", { status: "completed", errors: 2 }],
  ["cron-salesorder-reconciliation", { status: "completed", results: [{ status: "error" }] }],
  ["cron-inventory-reconciliation", { status: "completed", summary: { failedSyncs: 1 } }],
  [
    "cron-inventory-reconciliation",
    { status: "completed", details: [{ errors: ["provider unavailable"] }] },
  ],
  [
    "trigger-inventory-reconciliation",
    { status: "completed", reconciliation: { errors: ["failed"] } },
  ],
  [
    "trigger-inventory-reconciliation",
    { status: "completed", reconciliation: { syncActions: [{ success: false }] } },
  ],
  [
    "sync-sku-inventory",
    { status: "completed", gpsToD365: { success: true }, d365ToShopify: { success: false } },
  ],
  ["process-refund", { status: "success", invoiceResult: "error" }],
  ["process-backorder", { status: "exhausted" }],
])("records business failures from %s", (id, output) => {
  expect(classify(id as string, output)).toBe("failed");
});

it.each([
  { status: "skipped" },
  { status: "disabled" },
  { status: "dry_run" },
  { success: false, skipped: true },
  { success: true, dryRun: true },
  { status: "deferred" },
])("excludes non-processing outcomes: %j", (output) => {
  expect(classify("workflow", output)).toBe("skipped");
});

it("accepts real successes without interpreting raw provider objects as outcomes", () => {
  expect(classify("cron-gps-sync", { status: "completed", errors: 0 })).toBe("completed");
  expect(
    classify("cron-salesorder-reconciliation", { status: "completed", results: [{ status: "ok" }] })
  ).toBe("completed");
  expect(classify("process-order", { status: "success", order: { status: "error" } })).toBe(
    "completed"
  );
});
