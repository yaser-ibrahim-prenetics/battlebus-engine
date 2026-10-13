import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { orderReconciliationQueries } from "@/lib/db/queries/order-reconciliation";
import { reconTrace } from "./trace";
import type { OrderRow, ReconType } from "./types";

export async function fetchOrderRowsByName(
  names: string[],
  trace?: { runId: string; type: ReconType }
): Promise<{ rows: OrderRow[]; error: { message: string } | null }> {
  const out: OrderRow[] = [];
  if (names.length === 0) return { rows: out, error: null };

  const BATCH = 200;
  const seen = new Set<string>();
  let batchIdx = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    batchIdx += 1;
    const batchNames = names.slice(i, i + BATCH);
    let rows: OrderRow[];
    try {
      const result = await queryDatabase<OrderRow>(orderReconciliationQueries.findByNames, [
        batchNames,
      ]);
      rows = result.rows;
    } catch (error) {
      return {
        rows: out,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
    if (trace && config.reconciliation.verboseLog) {
      reconTrace(trace.runId, trace.type, "database_orders_in_batch", {
        batch: batchIdx,
        namesInBatch: batchNames.length,
        rowsReturned: rows.length,
      });
    }
    for (const r of rows) {
      const key = String(r.shopify_order_name || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  if (trace) {
    reconTrace(trace.runId, trace.type, "database_orders_done", {
      namesRequested: names.length,
      uniqueRows: out.length,
      batches: batchIdx,
    });
  }
  return { rows: out, error: null };
}

