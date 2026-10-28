import { probeDynamicsEvidence } from "@/lib/clients/dynamics/reconciliation";
import { probeShopifyEnvironment } from "@/lib/clients/operations/shopify";
import { compareOrderDetails } from "./details";
import { recordReconciliation } from "../reconciliation-history/record";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { beginRunSQL, completeRunSQL } from "@/lib/sql/d365-reconciliation/runs";
import { shopifyOrderNames } from "./shopify";
import { dynamicsOrderNames } from "./dynamics";
import { compareOrders } from "./compare";
import { companies, type Kind, type Window } from "./types";

async function runD365(kind: Kind, window: Window, workflowRunId: string) {
  const id = randomUUID();
  await queryDatabase(beginRunSQL, [
    id,
    workflowRunId,
    kind,
    config.shopify.im8.shopDomain,
    config.dynamics.baseUrl,
    window.start,
    window.end,
  ]);
  try {
    const environments = await Promise.all([
      probeShopifyEnvironment(),
      probeDynamicsEvidence("U001"),
      probeDynamicsEvidence("H007"),
    ]);
    // No orders table lookup: both evidence sets come independently from providers.
    const [shopify, dynamics] = await Promise.all([
      shopifyOrderNames(kind, window),
      dynamicsOrderNames(kind, window),
    ]);
    const result = {
      environments,
      ...compareOrders(shopify, dynamics),
      details: await compareOrderDetails(shopify, kind, window),
    };
    const hasDifferences =
      result.details.length > 0 ||
      result.missingInDynamics.length > 0 ||
      companies.some((company) => result.missingInShopify[company].length > 0);
    const status = hasDifferences ? "discrepancies" : "matched";
    const saved = await queryDatabase(completeRunSQL, [id, status, JSON.stringify(result), null]);
    if (saved.rowCount !== 1) throw new Error("Reconciliation completion could not be persisted");
    return { id, kind, status, ...result };
  } catch {
    // Failure is never an empty/matched result. No access tokens, provider response
    // bodies or customer data are copied into this diagnostic field.
    await queryDatabase(completeRunSQL, [id, "failed", null, "provider_or_persistence_failure"]);
    throw new Error(`Direct D365 reconciliation failed; inspect run ${id}`);
  }
}

export async function reconcileD365(kind: Kind, window: Window, workflowRunId: string) {
  return recordReconciliation(
    {
      workflowRunId,
      kind: `direct_${kind}`,
      scope: config.shopify.im8.shopDomain,
      start: window.start,
      end: window.end,
    },
    () => runD365(kind, window, workflowRunId),
    (result) => ({ status: result.status as "matched" | "discrepancies", result })
  );
}
