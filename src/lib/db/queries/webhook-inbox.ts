import { quoteIdentifier } from "@/lib/db/database";

export function createWebhookInboxQueries(tableName: string) {
  const table = quoteIdentifier(tableName);

  return {
    record: `INSERT INTO ${table} (source, topic, payload, headers, events, status)
       VALUES ($1, $2, $3, $4, $5, 'received')
       RETURNING id`,

    markPublished: `UPDATE ${table}
       SET status = 'published', published_at = now(), event_ids = $2
       WHERE id = $1`,

    markFailed: `UPDATE ${table}
       SET status = 'failed', attempts = attempts + 1, last_error = $2
       WHERE id = $1`,

    listUnpublished: `SELECT id, source, topic, events, attempts
       FROM ${table}
       WHERE status <> 'published'
       ORDER BY received_at ASC
       LIMIT $1`,
  } as const;
}
