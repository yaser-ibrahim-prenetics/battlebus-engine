export const REQUIRED_MODES = ["contract", "historical", "shadow", "recovery"] as const;
export type EvidenceSummary = {
  workflow_id: string;
  mode: string;
  samples: number;
  failures: number;
  production_samples: number;
  shadow_days: number;
  latest_at: string;
};
export const CUTOVER_POLICY = {
  contract: 1,
  historical: 100,
  shadow: 100,
  recovery: 4,
  shadowDays: 7,
  evidenceMaxAgeHours: 24,
} as const;

export function evaluateCutover(
  workflowIds: readonly string[],
  evidence: EvidenceSummary[],
  now = Date.now()
) {
  const workflows = workflowIds.map((workflowId) => {
    const blockers: string[] = [];
    for (const mode of REQUIRED_MODES) {
      const row = evidence.find((entry) => entry.workflow_id === workflowId && entry.mode === mode);
      if (!row || row.samples < CUTOVER_POLICY[mode])
        blockers.push(mode + ": insufficient distinct cases");
      if (row?.failures) blockers.push(mode + ": unresolved failures");
      if (
        row &&
        (!Number.isFinite(Date.parse(row.latest_at)) ||
          now - Date.parse(row.latest_at) > CUTOVER_POLICY.evidenceMaxAgeHours * 3_600_000 ||
          Date.parse(row.latest_at) > now)
      )
        blockers.push(mode + ": stale or invalid evidence");
      if (
        (mode === "historical" || mode === "shadow") &&
        (!row || row.production_samples < CUTOVER_POLICY[mode])
      ) {
        blockers.push(mode + ": insufficient production evidence");
      }
      if (mode === "shadow" && (!row || row.shadow_days < CUTOVER_POLICY.shadowDays)) {
        blockers.push("shadow: observation window incomplete");
      }
    }
    return { workflowId, ready: blockers.length === 0, blockers };
  });
  return {
    ready: workflows.length > 0 && workflows.every((workflow) => workflow.ready),
    workflows,
  };
}
