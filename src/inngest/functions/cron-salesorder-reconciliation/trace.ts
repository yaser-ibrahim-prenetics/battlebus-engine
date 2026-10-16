import { config } from "@/lib/config";
import { logFlowEvent } from "@/lib/services/flow-logs";
import type { ReconType } from "./types";

export function reconTrace(
  runId: string,
  reconType: ReconType,
  phase: string,
  data: Record<string, unknown>
): void {
  const line = {
    tag: "reconciliation",
    at: new Date().toISOString(),
    runId: runId || undefined,
    reconType,
    phase,
    ...data,
  };
  console.log(JSON.stringify(line));
  if (config.reconciliation.verboseLog && runId) {
    logFlowEvent({
      level: "info",
      flow: "reconciliation_trace",
      step: phase,
      status: "running",
      runId,
      payload: { reconType, ...data },
    });
  }
}
