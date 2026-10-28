import { createHash } from "node:crypto";
import type { GetStepTools } from "inngest";
import type { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import { getDatabasePool, queryDatabase } from "@/lib/db/database";
import { probeDynamicsEvidence } from "@/lib/clients/dynamics/reconciliation";
import { probeShopifyEnvironment } from "@/lib/clients/operations/shopify";
import { beginDurableRunSQL, completeDurableRunSQL } from "@/lib/sql/d365-reconciliation/runs";
import {
  beginDurableAttemptSQL,
  finishDurableAttemptSQL,
  failWorkflowReconciliationsSQL,
} from "@/lib/sql/reconciliation-history/attempts";
import { shopifyOrderNames } from "./shopify";
import { dynamicsOrderNames } from "./dynamics";
import { compareOrders } from "./compare";
import { compareOrderDetails } from "./details";
import { companies, type Kind, type Window } from "./types";

type Steps = Pick<GetStepTools<typeof inngest>, "run">;

/** Checkpoints provider reads in small parallel batches, below Inngest's step limit.
 * Interrupted runs remain visible as running until resumed or administratively closed.
 */
export async function reconcileD365Durably(kind: Kind, window: Window, runId: string, step: Steps) {
  const prefix = `direct-${kind}`;
  const id = await step.run(`${prefix}-begin`, async () => {
    const pool = await getDatabasePool();
    if (!pool) throw new Error("Reconciliation database unavailable");
    const client = await pool.connect();
    const digest = createHash("sha256")
      .update(JSON.stringify([runId, kind]))
      .digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    try {
      await client.query("BEGIN");
      await client.query(beginDurableRunSQL, [
        id,
        runId,
        kind,
        config.shopify.im8.shopDomain,
        config.dynamics.baseUrl,
        window.start,
        window.end,
      ]);
      await client.query(beginDurableAttemptSQL, [
        id,
        runId,
        `direct_${kind}`,
        config.shopify.im8.shopDomain,
        window.start,
        window.end,
      ]);
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  const environments = await step.run(`${prefix}-verify-environments`, () =>
    Promise.all([
      probeShopifyEnvironment(),
      probeDynamicsEvidence("U001"),
      probeDynamicsEvidence("H007"),
    ])
  );
  const names = await step.run(`${prefix}-shopify-references`, async () => {
    const names = [...(await shopifyOrderNames(kind, window))].sort();
    if (names.length > 2000)
      throw new Error("Detailed reconciliation exceeds 2000 orders; use a smaller window");
    return names;
  });
  const references = await step.run(`${prefix}-compare-references`, async () =>
    compareOrders(new Set(names), await dynamicsOrderNames(kind, window))
  );
  const details: Awaited<ReturnType<typeof compareOrderDetails>> = [];
  // Five concurrent independent orders per checkpoint; at most 400 checkpoints per kind.
  for (let offset = 0; offset < names.length; offset += 5) {
    const batch = await step.run(`${prefix}-details-${offset}`, async () =>
      (
        await Promise.all(
          names
            .slice(offset, offset + 5)
            .map((name) => compareOrderDetails(new Set([name]), kind, window))
        )
      ).flat()
    );
    details.push(...batch);
  }
  return step.run(`${prefix}-complete`, async () => {
    const result = { environments, ...references, details };
    const status =
      details.length ||
      references.missingInDynamics.length ||
      companies.some((company) => references.missingInShopify[company].length)
        ? "discrepancies"
        : "matched";
    const pool = await getDatabasePool();
    if (!pool) throw new Error("Reconciliation database unavailable");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sql of [completeDurableRunSQL, finishDurableAttemptSQL]) {
        const saved = await client.query(sql, [id, status, JSON.stringify(result), null]);
        if (saved.rowCount !== 1)
          throw new Error("Reconciliation completion could not be persisted");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // Full evidence stays in PostgreSQL; keep workflow outputs bounded.
    return {
      id,
      kind,
      status,
      differenceCount: details.length,
      shopifyCount: references.shopifyCount,
    };
  });
}

export async function failReconciliationWorkflow(runId: string) {
  await queryDatabase(failWorkflowReconciliationsSQL, [runId, "workflow_retries_exhausted"]);
}
