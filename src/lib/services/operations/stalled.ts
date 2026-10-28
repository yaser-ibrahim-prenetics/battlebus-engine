import { queryDatabase } from "@/lib/db/database";
import { readWorkflowStatus, cancelWorkflow } from "@/lib/clients/operations/inngest";
import {
  cancellableWorkflowSQL,
  abandonedReconciliationSQL,
  closeAbandonedReconciliationSQL,
} from "@/lib/sql/operations/workflows";
const terminal = new Set(["Completed", "Failed", "Cancelled"]);
export async function cancelStuckWorkflow(runId: string) {
  const row = (await queryDatabase(cancellableWorkflowSQL, [runId])).rows[0];
  if (!row) throw new Error("Workflow is not a verified stale local run");
  const status = await readWorkflowStatus(runId);
  if (terminal.has(status)) return { runId, alreadyTerminal: true };
  if (status !== "Running") throw new Error("Workflow state cannot be safely cancelled");
  return { runId, ...(await cancelWorkflow(runId)) };
}
export async function closeStaleReconciliation(id: string) {
  const row = (await queryDatabase<{ workflow_run_id: string }>(abandonedReconciliationSQL, [id]))
    .rows[0];
  if (!row?.workflow_run_id) throw new Error("No stale reconciliation workflow to verify");
  if (!terminal.has(await readWorkflowStatus(row.workflow_run_id)))
    throw new Error("Reconciliation workflow is still active");
  const result = await queryDatabase(closeAbandonedReconciliationSQL, [id]);
  if (result.rowCount !== 1) throw new Error("Reconciliation changed during verification");
  return { reconciliationId: id, closed: true };
}
