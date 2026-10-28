import { reconcileUncertainFulfillments } from "@/lib/services/fulfillment-actions/recovery";
import { inngest } from "../client";
import { config } from "@/lib/config";
import { reconciliationWindow } from "@/lib/services/d365-reconciliation/window";
import { reconcileD365 } from "@/lib/services/d365-reconciliation/run";
import type { Kind } from "@/lib/services/d365-reconciliation/types";

export const cronD365Reconciliation = inngest.createFunction(
  {
    id: "direct-shopify-d365-reconciliation",
    name: "Direct Shopify to D365 reconciliation",
    retries: 2,
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
    for (const kind of kinds)
      results.push(await step.run(`reconcile-${kind}`, () => reconcileD365(kind, window, runId)));
    const recovery = await step.run(
      "reconcile-uncertain-fulfillments",
      reconcileUncertainFulfillments
    );
    return { window, results, recovery };
  }
);
