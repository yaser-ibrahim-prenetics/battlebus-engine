export type WorkflowHealth = {
  function_id: string;
  completed: number;
  failed: number;
  latency_seconds: number | null;
  backlog: number;
  backlog_age_seconds: number;
};

// Provisional objectives; business holds remain visible in wall-clock latency.
export const SLO_TARGETS = {
  latencySeconds: 1800, errorRate: 0.01, backlogAgeSeconds: 3600, minimumSamples: 100,
};
export function evaluateSlo(row: WorkflowHealth) {
  const errorRate = row.completed ? row.failed / row.completed : null;
  const blockers: string[] = [];
  if (row.completed < SLO_TARGETS.minimumSamples) blockers.push("insufficient samples");
  if (row.latency_seconds == null || Number(row.latency_seconds) > SLO_TARGETS.latencySeconds) blockers.push("processing latency");
  if (errorRate == null || errorRate > SLO_TARGETS.errorRate) blockers.push("error rate");
  if (Number(row.backlog_age_seconds) > SLO_TARGETS.backlogAgeSeconds) blockers.push("backlog age");
  return { ...row, errorRate, ok: blockers.length === 0, blockers };
}

