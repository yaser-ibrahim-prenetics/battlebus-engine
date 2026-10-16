import { quoteIdentifier } from "@/lib/db/database";

export function createFlowLogQueries(
  tableName: string,
  timelineTableName = "workflow_timeline_events"
) {
  const table = quoteIdentifier(tableName);
  const timeline = quoteIdentifier(timelineTableName);

  return {
    prune: `DELETE FROM ${table} WHERE ts < $1`,
    insert(columns: string[], rowCount: number): string {
      const tuples = Array.from({ length: rowCount }, (_, rowIndex) => {
        const offset = rowIndex * columns.length;
        return `(${columns.map((__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
      });
      return `WITH inserted AS (
        INSERT INTO ${table} (${columns.map(quoteIdentifier).join(", ")})
        VALUES ${tuples.join(", ")}
        RETURNING *
      )
      INSERT INTO ${timeline} (
        idempotency_key, shopify_order_id, shopify_order_name,
        source, event_type, stage, status, message, run_id,
        error_class, metadata, occurred_at
      )
      SELECT concat('flow-log:', id::text),
             shopify_order_id, shopify_order_name,
             COALESCE(client, flow), 'workflow', COALESCE(step, flow),
             COALESCE(status, level), error_message, run_id, error_type,
             jsonb_strip_nulls(jsonb_build_object(
               'flow', flow,
               'durationMs', duration_ms,
               'requestId', request_id,
               'd365OrderNumber', d365_order_number
             )),
             ts
      FROM inserted
      WHERE shopify_order_id IS NOT NULL OR shopify_order_name IS NOT NULL
      ON CONFLICT (idempotency_key) DO NOTHING`;
    },
  } as const;
}
