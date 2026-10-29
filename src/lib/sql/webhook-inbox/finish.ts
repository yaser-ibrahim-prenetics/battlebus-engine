import { quoteIdentifier } from "@/lib/db/database";

export function createPublishWebhookInboxEntrySQL(tableName: string): string {
  const table = quoteIdentifier(tableName);

  return `UPDATE ${table}
    SET status = 'published',
        published_at = COALESCE(published_at, now()),
        event_ids = $3::text[],
        lease_token = NULL,
        lease_expires_at = NULL,
        dead_lettered_at = NULL,
        last_error = NULL
    WHERE id = $1::uuid
      AND lease_token = $2::uuid
      AND status IN ('received', 'failed')
    RETURNING id`;
}

export function createFailWebhookInboxEntrySQL(tableName: string): string {
  const table = quoteIdentifier(tableName);

  return `UPDATE ${table}
    SET status = 'failed',
        next_attempt_at = CASE
          WHEN attempts >= $4::integer OR $6::boolean THEN next_attempt_at
          ELSE now() + make_interval(secs => $5::integer)
        END,
        dead_lettered_at = CASE
          WHEN attempts >= $4::integer OR $6::boolean
            THEN COALESCE(dead_lettered_at, now())
          ELSE NULL
        END,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = left($3, 500)
    WHERE id = $1::uuid
      AND lease_token = $2::uuid
      AND status IN ('received', 'failed')
    RETURNING id, attempts, dead_lettered_at`;
}

export function createRequeueWebhookInboxDeadLetterSQL(tableName: string): string {
  const table = quoteIdentifier(tableName);

  return `UPDATE ${table}
    SET status = 'failed',
        attempts = 0,
        replay_count = replay_count + 1,
        next_attempt_at = now(),
        dead_lettered_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = NULL
    WHERE id = $1::uuid
      AND status = 'failed'
      AND dead_lettered_at IS NOT NULL
      AND lease_token IS NULL
    RETURNING id, replay_count`;
}
