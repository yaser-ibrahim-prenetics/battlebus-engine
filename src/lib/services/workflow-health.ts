import { queryDatabase } from "@/lib/db/database";
import { workflowHealthQueries as queries } from "@/lib/db/queries/workflow-health";
import { evaluateSlo, SLO_TARGETS, type WorkflowHealth } from "@/lib/domain/cutover/slo";

export async function getWorkflowHealth(revision: string) {
  const [runs, outbox] = await Promise.all([
    queryDatabase<WorkflowHealth>(queries.report, [revision]),
    queryDatabase<{ backlog: number; backlog_age_seconds: number; dead_letters: number }>(queries.outbox),
  ]);
  const workflows = runs.rows.map(evaluateSlo);
  const queue = outbox.rows[0];
  return {
    ok: workflows.length > 0 && workflows.every((w) => w.ok) &&
      queue.dead_letters === 0 && Number(queue.backlog_age_seconds) <= SLO_TARGETS.backlogAgeSeconds,
    revision, windowHours: 24, targets: SLO_TARGETS, workflows, outbox: queue,
    note: "Wall-clock time includes intentional sleeps and refund holds; objectives require operational review.",
  };
}

