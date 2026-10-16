import { quoteIdentifier } from "@/lib/db/database";

export function createWebhookInboxQueries(
  inboxTableName: string,
  outboxTableName = "event_outbox"
) {
  const inbox = quoteIdentifier(inboxTableName);
  const outbox = quoteIdentifier(outboxTableName);

  return {
    recordWithOutbox: `WITH receipt AS (
         INSERT INTO ${inbox} (
           source, topic, payload, headers, events, status,
           idempotency_key, schema_version, payload_hash, published_at
         )
         VALUES (
           $1, $2, $3::jsonb, $4::jsonb, $5::jsonb,
           CASE WHEN jsonb_array_length($5::jsonb) = 0 THEN 'published' ELSE 'received' END,
           $6, $7, $8,
           CASE WHEN jsonb_array_length($5::jsonb) = 0 THEN now() ELSE NULL END
         )
         ON CONFLICT (source, idempotency_key) DO UPDATE
           SET duplicate_count = ${inbox}.duplicate_count + 1,
               updated_at = now()
         RETURNING id, status, payload_hash, duplicate_count
       ), queued AS (
         INSERT INTO ${outbox} (
           inbox_id, source, topic, schema_version, event_name, event_id,
           event_data, idempotency_key, shopify_order_id, shopify_order_name
         )
         SELECT receipt.id, $1, $2, $7, item.event_name, item.event_id,
                item.event_data, item.idempotency_key,
                item.shopify_order_id, item.shopify_order_name
         FROM receipt
         CROSS JOIN LATERAL jsonb_to_recordset($9::jsonb) AS item(
           event_name text,
           event_id text,
           event_data jsonb,
           idempotency_key text,
           shopify_order_id text,
           shopify_order_name text
         )
         ON CONFLICT (idempotency_key) DO NOTHING
       )
       SELECT id, status, payload_hash, duplicate_count FROM receipt`,

    claimForInbox: `WITH candidates AS (
         SELECT id
         FROM ${outbox}
         WHERE inbox_id = $1
           AND (
             (state = 'pending' AND available_at <= now())
             OR (state = 'processing' AND lease_expires_at <= now())
           )
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE ${outbox} queued
       SET state = 'processing', claim_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $3),
           attempts = attempts + 1
       FROM candidates
       WHERE queued.id = candidates.id
       RETURNING queued.id, queued.inbox_id, queued.source, queued.topic,
                 queued.schema_version, queued.event_name, queued.event_id,
                 queued.event_data, queued.idempotency_key,
                 queued.shopify_order_id, queued.shopify_order_name,
                 queued.attempts, queued.claim_token`,

    claimDue: `WITH candidates AS (
         SELECT id
         FROM ${outbox}
         WHERE (
             (state = 'pending' AND available_at <= now())
             OR (state = 'processing' AND lease_expires_at <= now())
           )
           AND ($2::uuid IS NULL OR id = $2::uuid)
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE ${outbox} queued
       SET state = 'processing', claim_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $3),
           attempts = attempts + 1
       FROM candidates
       WHERE queued.id = candidates.id
       RETURNING queued.id, queued.inbox_id, queued.source, queued.topic,
                 queued.schema_version, queued.event_name, queued.event_id,
                 queued.event_data, queued.idempotency_key,
                 queued.shopify_order_id, queued.shopify_order_name,
                 queued.attempts, queued.claim_token`,

    markOutboxPublished: `UPDATE ${outbox}
       SET state = 'published', published_at = now(),
           claim_token = NULL, lease_expires_at = NULL,
           last_error = NULL, error_class = NULL, recovery_action = NULL
       WHERE id = $1 AND claim_token = $2::uuid AND state = 'processing'
       RETURNING inbox_id`,

    markOutboxFailed: `UPDATE ${outbox}
       SET state = CASE WHEN $5::boolean THEN 'dead_letter' ELSE 'pending' END,
           available_at = CASE
             WHEN $5::boolean THEN available_at
             ELSE now() + make_interval(secs => $6::integer)
           END,
           claim_token = NULL, lease_expires_at = NULL,
           last_error = $3, error_class = $4, recovery_action = $7,
           dead_lettered_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
       WHERE id = $1 AND claim_token = $2::uuid AND state = 'processing'
       RETURNING inbox_id, state`,

    refreshInboxStatus: `UPDATE ${inbox} receipt
       SET status = CASE
             WHEN NOT EXISTS (SELECT 1 FROM ${outbox} WHERE inbox_id = receipt.id)
               THEN 'published'
             WHEN EXISTS (
               SELECT 1 FROM ${outbox} WHERE inbox_id = receipt.id AND state = 'dead_letter'
             ) THEN 'failed'
             WHEN NOT EXISTS (
               SELECT 1 FROM ${outbox} WHERE inbox_id = receipt.id AND state <> 'published'
             ) THEN 'published'
             ELSE 'received'
           END,
           attempts = COALESCE((
             SELECT max(attempts) FROM ${outbox} WHERE inbox_id = receipt.id
           ), receipt.attempts),
           last_error = (
             SELECT last_error FROM ${outbox}
             WHERE inbox_id = receipt.id AND last_error IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1
           ),
           event_ids = ARRAY(
             SELECT event_id FROM ${outbox}
             WHERE inbox_id = receipt.id AND state = 'published' AND event_id IS NOT NULL
             ORDER BY created_at
           ),
           published_at = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM ${outbox} WHERE inbox_id = receipt.id AND state <> 'published'
             ) THEN COALESCE(receipt.published_at, now())
             ELSE NULL
           END
       WHERE receipt.id = $1
       RETURNING status`,

    requeueDeadLetter: `UPDATE ${outbox}
       SET state = 'pending', available_at = now(),
           claim_token = NULL, lease_expires_at = NULL,
           last_error = NULL, error_class = NULL, recovery_action = NULL,
           dead_lettered_at = NULL
       WHERE id = $1::uuid AND state = 'dead_letter'
       RETURNING id, inbox_id`,

    listDeadLetters: `SELECT id, inbox_id, source, topic, schema_version,
              event_name, event_id, idempotency_key, shopify_order_id,
              shopify_order_name, attempts, last_error, error_class,
              recovery_action, dead_lettered_at
       FROM ${outbox}
       WHERE state = 'dead_letter'
       ORDER BY dead_lettered_at DESC
       LIMIT $1`,
  } as const;
}
