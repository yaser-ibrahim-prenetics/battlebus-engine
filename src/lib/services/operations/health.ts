import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { queueHealthSQL } from "@/lib/sql/operations/health";
import { staleWorkflowsSQL, completeWorkflowSQL } from "@/lib/sql/operations/workflows";
import { probeShopifyEnvironment } from "@/lib/clients/operations/shopify";
import { probeDynamicsEvidence } from "@/lib/clients/dynamics/reconciliation";
import { probeInngest, readWorkflowStatus } from "@/lib/clients/operations/inngest";
import { probeHub, probeGps } from "@/lib/clients/operations/dependencies";
async function probe(name: string, enabled: boolean, execute: () => Promise<unknown>) {
  if (!enabled) return { name, status: "disabled" as const };
  const start = Date.now();
  try {
    const evidence = await execute();
    return {
      name,
      status: "ready" as const,
      latencyMs: Date.now() - start,
      evidence,
    };
  } catch {
    return {
      name,
      status: "unavailable" as const,
      latencyMs: Date.now() - start,
      errorCode: "dependency_probe_failed",
    };
  }
}
export async function deepReadiness() {
  const dependencies = await Promise.all([
    probe("cloudSql", true, async () => {
      await queryDatabase("SELECT 1");
      return { connectivity: "verified" };
    }),
    probe("shopify", true, probeShopifyEnvironment),
    probe(
      "d365U001",
      config.features.enableDynamicsSync || config.reconciliation.directD365Enabled,
      () => probeDynamicsEvidence("U001")
    ),
    probe(
      "d365H007",
      config.features.enableDynamicsSync || config.reconciliation.directD365Enabled,
      () => probeDynamicsEvidence("H007")
    ),
    probe("inngest", true, probeInngest),
    probe("battleHub", config.csPlatform.enabled, probeHub),
    probe("gpsUS", config.features.enableGpsSync, () => probeGps("US")),
    probe("gpsUK", config.features.enableGpsSync, () => probeGps("UK")),
  ]);
  const queues = (await queryDatabase(queueHealthSQL)).rows[0];
  const candidates = (
    await queryDatabase<{
      run_id: string;
      function_id: string;
      last_seen_at: string;
      unknown_wait: boolean;
    }>(staleWorkflowsSQL)
  ).rows;
  const workflows: Array<
    (typeof candidates)[number] & { status: string; providerStatus?: string }
  > = [];
  for (let offset = 0; offset < Math.min(candidates.length, 25); offset += 5) {
    await Promise.all(
      candidates.slice(offset, Math.min(offset + 5, 25)).map(async (candidate) => {
        try {
          const status = await readWorkflowStatus(candidate.run_id);
          if (["Completed", "Failed", "Cancelled"].includes(status)) {
            await queryDatabase(completeWorkflowSQL, [candidate.run_id]);
            return;
          }
          workflows.push({
            ...candidate,
            status: candidate.unknown_wait ? "waiting_state_unknown" : "stalled",
            providerStatus: status,
          });
        } catch {
          workflows.push({ ...candidate, status: "verification_unavailable" });
        }
      })
    );
  }
  const truncated = candidates.length > 25;
  return {
    checkedAt: new Date().toISOString(),
    ok:
      dependencies.every((d) => d.status !== "unavailable") &&
      queues.inbox_age_seconds < 300 &&
      !queues.inbox_dead_letter_count &&
      !queues.inbox_expired_lease_count &&
      queues.uncertain_age_seconds < 300 &&
      !queues.stale_reconciliation_count &&
      (!config.oosRecovery.enabled ||
        (queues.oos_due_age_seconds < 3600 &&
          !queues.oos_expired_lease_count &&
          !queues.oos_outbox_exhausted_count)) &&
      !workflows.length &&
      !truncated,
    dependencies,
    queues,
    workflows,
    truncated,
    dryRun: config.features.dryRunMode,
    thresholds: {
      inboxAgeSeconds: 300,
      uncertainActionAgeSeconds: 300,
      workflowIdleSeconds: 1800,
      oosDueAgeSeconds: 3600,
    },
  };
}
