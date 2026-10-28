import { config } from "@/lib/config";
import { getDatabasePool, queryDatabase } from "@/lib/db/database";
import { readHeaderEvidence, readSlipEvidence } from "@/lib/clients/dynamics/reconciliation";
import { lockOrderSQL } from "@/lib/sql/fulfillment-actions/reserve";
import {
  competingAttemptsSQL,
  readAttemptSQL,
  lockAttemptSQL,
  uncertainAttemptsSQL,
  claimEvidenceSQL,
  resolveAttemptSQL,
} from "@/lib/sql/fulfillment-actions/recovery";
import type { Company } from "../d365-reconciliation/types";
import type { FulfillmentRecoveryContext } from "./recovery-context";
import { matchShipmentEvidence } from "./evidence";
import { fingerprint } from "./identity";
interface AttemptRow {
  action_key: string;
  provider: string;
  scope: string;
  source_order_id: string;
  source_line_id: string;
  action_name: string;
  attempt_id: string;
  request_hash: string;
  recovery_context: FulfillmentRecoveryContext | null;
  status: string;
  settled: boolean;
}
export async function reconcileFulfillmentAttempt(attemptId: string) {
  const initial = await queryDatabase<AttemptRow>(readAttemptSQL, [attemptId]);
  const row = initial.rows[0];
  const context = row?.recovery_context;
  if (
    !context ||
    !initial.rows.length ||
    initial.rows.some(
      (r) =>
        !r.settled ||
        !["pending", "uncertain"].includes(r.status) ||
        r.provider !== row.provider ||
        r.scope !== row.scope ||
        r.source_order_id !== row.source_order_id ||
        r.action_name !== row.action_name ||
        r.request_hash !== row.request_hash ||
        fingerprint(r.recovery_context) !== fingerprint(context)
    )
  )
    return { attemptId, resolved: false, reason: "missing_or_unsettled_evidence" };
  if (
    row.provider !== "dynamics" ||
    !["U001", "H007"].includes(context.company) ||
    row.scope !== `${config.dynamics.baseUrl}:${context.company}` ||
    row.source_order_id !== context.salesOrderNumber
  )
    throw new Error("Fulfillment evidence environment mismatch");
  if (
    fingerprint(initial.rows.map((r) => r.source_line_id).sort()) !==
    fingerprint([...new Set(context.lines.map((line) => line.lotId))].sort())
  )
    throw new Error("Fulfillment evidence line identities do not match the reserved action");
  const company = context.company as Company;
  const [headers, slips] = await Promise.all([
    readHeaderEvidence(company, context.salesOrderNumber),
    readSlipEvidence(company, context.salesOrderNumber),
  ]);
  const evidence = matchShipmentEvidence(context, headers, slips);
  if (!evidence) return { attemptId, resolved: false, reason: "provider_proof_inconclusive" };
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Recovery database unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(lockOrderSQL, [
      JSON.stringify([row.provider, row.scope, row.source_order_id]),
    ]);
    const current = await client.query<AttemptRow>(lockAttemptSQL, [attemptId]);
    if (fingerprint(current.rows) !== fingerprint(initial.rows))
      throw new Error("Fulfillment attempt changed during verification");
    const competing = await client.query(competingAttemptsSQL, [
      row.provider,
      row.scope,
      row.source_order_id,
      context.lines.map((line) => line.lotId),
      attemptId,
      `${context.salesOrderNumber}:${evidence.documentId}`,
    ]);
    if (competing.rows.length)
      throw new Error("Provider evidence may belong to another shipment attempt");
    const claim = await client.query(claimEvidenceSQL, [
      row.provider,
      row.scope,
      `${context.salesOrderNumber}:${evidence.documentId}`,
      attemptId,
      JSON.stringify(evidence),
    ]);
    if (claim.rowCount !== 1)
      throw new Error("Provider document already assigned to another action");
    const saved = await client.query(resolveAttemptSQL, [
      attemptId,
      JSON.stringify({
        status: 1,
        Message: "Success",
        Result: evidence.documentId,
        $id: attemptId,
      }),
    ]);
    if (saved.rowCount !== initial.rows.length)
      throw new Error("Fulfillment recovery did not update the entire batch");
    await client.query("COMMIT");
    return { attemptId, resolved: true, documentId: evidence.documentId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function reconcileUncertainFulfillments() {
  const { rows } = await queryDatabase<{ attempt_id: string }>(uncertainAttemptsSQL, [100]);
  const results = [];
  for (const row of rows) results.push(await reconcileFulfillmentAttempt(row.attempt_id));
  return results;
}
