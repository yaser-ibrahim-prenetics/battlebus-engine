import registry from "../../../../config/spock-workflows.json";
import { queryDatabase } from "@/lib/db/database";
import { cutoverEvidenceQueries as queries } from "@/lib/db/queries/cutover-evidence";
import { evaluateCutover, CUTOVER_POLICY, type EvidenceSummary } from "@/lib/domain/cutover/gate";
import type { ReplayEvidence } from "./replay";

export async function persistReplayEvidence(e: ReplayEvidence): Promise<void> {
  if (!registry.workflows.some((w) => w.id === e.workflowId)) throw new Error("Unknown workflow");
  if (e.spockRevision !== registry.spockRevision) throw new Error("Unpinned Spock reference");
  await queryDatabase(queries.insert, [
    e.id, e.caseId, e.workflowId, e.mode, e.provenance, e.sourceReference, e.capturedAt,
    e.inputHash, e.spockRevision, e.busRevision, e.status, JSON.stringify(e.differences),
    e.spockHash, e.busHash, e.startedAt, e.completedAt,
  ]);
}

export async function getCutoverReport(busRevision: string) {
  if (!/^[a-f0-9]{40}$/.test(busRevision)) throw new Error("An immutable Bus git revision is required");
  const [summary, recent] = await Promise.all([
    queryDatabase<EvidenceSummary>(queries.summary, [registry.spockRevision, busRevision]),
    queryDatabase(queries.recent, [registry.spockRevision, busRevision]),
  ]);
  return {
    ...evaluateCutover(registry.workflows.map((w) => w.id), summary.rows),
    spockRevision: registry.spockRevision, busRevision,
    checkedAt: new Date().toISOString(), policy: CUTOVER_POLICY, recent: recent.rows,
    evidence: summary.rows,
  };
}

