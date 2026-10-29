import { quoteIdentifier } from "@/lib/db/database";

export function createClaimWebhookInboxEntriesSQL(tableName: string): string {
  const table = quoteIdentifier(tableName);

  return `WITH exhausted AS (
      UPDATE ${table}
      SET status = 'failed',
          dead_lettered_at = COALESCE(dead_lettered_at, now()),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = 'delivery_lease_expired_at_attempt_limit'
      WHERE status IN ('received', 'failed')
        AND dead_lettered_at IS NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at <= now()
        AND attempts >= $3
      RETURNING id
    ), candidates AS (
      SELECT receipt.id
      FROM ${table} AS receipt
      WHERE ($4::uuid IS NULL OR receipt.id = $4::uuid)
        AND receipt.status IN ('received', 'failed')
        AND receipt.dead_lettered_at IS NULL
        AND receipt.id NOT IN (SELECT id FROM exhausted)
        AND (
          (receipt.lease_token IS NULL
            AND receipt.next_attempt_at <= now()
            AND receipt.attempts < $3)
          OR
          (receipt.lease_token IS NOT NULL
            AND receipt.lease_expires_at <= now()
            AND receipt.attempts < $3)
        )
      ORDER BY receipt.next_attempt_at, receipt.received_at, receipt.id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE ${table} AS receipt
    SET lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => $2::integer),
        attempts = receipt.attempts + 1,
        last_error = CASE
          WHEN receipt.lease_token IS NOT NULL THEN 'delivery_lease_expired'
          ELSE receipt.last_error
        END
    FROM candidates
    WHERE receipt.id = candidates.id
    RETURNING receipt.id, receipt.source, receipt.topic, receipt.events,
              receipt.attempts, receipt.replay_count, receipt.lease_token,
              receipt.lease_expires_at`;
}
