import { quoteIdentifier } from "@/lib/db/database";

export function createDeleteRetainedWebhookInboxEntriesSQL(tableName: string): string {
  const table = quoteIdentifier(tableName);

  return `WITH candidates AS (
      SELECT id
      FROM ${table}
      WHERE status = 'published'
        AND published_at <= now() - make_interval(days => $1::integer)
      ORDER BY published_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    DELETE FROM ${table} AS receipt
    USING candidates
    WHERE receipt.id = candidates.id
    RETURNING receipt.id`;
}
