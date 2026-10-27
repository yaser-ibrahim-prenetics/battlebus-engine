import { quoteIdentifier } from "@/lib/db/database";

export function completedRefundSQL(tableName = "flow_logs") {
  return `SELECT 1 FROM ${quoteIdentifier(tableName)}
    WHERE flow = 'refund'
      AND step = ANY($1::text[])
      AND status = 'completed'
      AND payload->>'refundId' = $2
      AND ($3::text IS NULL OR run_id IS DISTINCT FROM $3)
    LIMIT 1`;
}
