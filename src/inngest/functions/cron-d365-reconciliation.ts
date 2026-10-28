import { logRecoveryFailure } from "@/lib/services/operations/diagnostics";
import {
  listUncertainFulfillmentAttempts,
  reconcileFulfillmentAttempt,
} from "@/lib/services/fulfillment-actions/recovery";
import { inngest } from "../client";
import { config } from "@/lib/config";
import { reconciliationWindow } from "@/lib/services/d365-reconciliation/window";
import {
  reconcileD365Durably,
  failReconciliationWorkflow,
} from "@/lib/services/d365-reconciliation/durable-run";
import type { Kind } from "@/lib/services/d365-reconciliation/types";

export const cronD365Reconciliation = inngest.createFunction(
  {
    id: "direct-shopify-d365-reconciliation",
    name: "Direct Shopify to D365 reconciliation",
    retries: 2,
    onFailure: async ({ event }) => {
      await failReconciliationWorkflow(event.data.run_id);
    },
    concurrency: { limit: 1 },
    triggers: [{ cron: "30 1 * * *" }, { event: "reconciliation/d365.run" }],
  },
  async ({ event, step, runId }) => {
    if (!config.reconciliation.directD365Enabled)
      return { skipped: true, reason: "Direct D365 reconciliation disabled" };
    const data = event.data as { type?: string; dateFrom?: string; dateTo?: string };
    if (data.type && !["all", "salesorder", "fulfillment"].includes(data.type))
      throw new Error("Unknown direct reconciliation type");
    const window = await step.run("resolve-window", () =>
      reconciliationWindow(data.dateFrom, data.dateTo)
    );
    const kinds: Kind[] =
      !data.type || data.type === "all" ? ["salesorder", "fulfillment"] : [data.type as Kind];
    const results = [];
    for (const kind of kinds) results.push(await reconcileD365Durably(kind, window, runId, step));
    const attempts = await step.run(
      "list-uncertain-fulfillments",
      listUncertainFulfillmentAttempts
    );
    const recovery = [];
    for (const attemptId of attempts) {
      recovery.push(
        await step.run(`recover-${attemptId}`, async () => {
          try {
            return await reconcileFulfillmentAttempt(attemptId);
          } catch (error) {
            const reason = logRecoveryFailure({ attemptId, runId }, error);
            return { attemptId, resolved: false, reason };
          }
        })
      );
    }
    return { window, results, recovery };
  }
);
