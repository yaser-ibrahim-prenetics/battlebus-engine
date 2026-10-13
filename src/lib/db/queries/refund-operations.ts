export const refundOperationQueries = {
  reserve: `WITH claimed AS (
       INSERT INTO public.refund_operations (
         refund_id,
         shopify_order_id,
         event_name,
         event_data,
         state,
         available_at,
         claim_token,
         lease_expires_at,
         hold_until,
         hold_reason
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         CASE WHEN $7::timestamptz > now() THEN 'awaiting_order' ELSE 'processing' END,
         CASE WHEN $7::timestamptz > now() THEN $7::timestamptz ELSE now() END,
         CASE WHEN $7::timestamptz > now() THEN NULL ELSE $5::uuid END,
         CASE
           WHEN $7::timestamptz > now() THEN NULL
           ELSE now() + ($6 * interval '1 second')
         END,
         CASE WHEN $7::timestamptz > now() THEN $7::timestamptz ELSE NULL END,
         CASE WHEN $7::timestamptz > now() THEN $8 ELSE NULL END
       )
       ON CONFLICT (refund_id) DO UPDATE
       SET shopify_order_id = EXCLUDED.shopify_order_id,
           event_name = EXCLUDED.event_name,
           event_data = EXCLUDED.event_data,
           state = 'processing',
           claim_token = $5::uuid,
           lease_expires_at = now() + ($6 * interval '1 second'),
           attempts = refund_operations.attempts + 1,
           last_error = NULL
       WHERE refund_operations.state = 'awaiting_order'
         AND refund_operations.available_at <= now()
         AND EXCLUDED.state = 'processing'
       RETURNING (state = 'processing') AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key,
         hold_until, hold_reason
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key, hold_until, hold_reason FROM claimed
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key, hold_until, hold_reason
     FROM public.refund_operations
     WHERE refund_id = $1
       AND NOT EXISTS (SELECT 1 FROM claimed)
     LIMIT 1`,

  acceptRecovery: `WITH accepted AS (
       UPDATE public.refund_operations
       SET state = resume_state,
           resume_state = NULL,
           lease_expires_at = now() + ($3 * interval '1 second'),
           last_error = NULL
       WHERE refund_id = $1
         AND claim_token = $2::uuid
         AND state = 'dispatching'
       RETURNING true AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key FROM accepted
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key
     FROM public.refund_operations
     WHERE refund_id = $1
       AND NOT EXISTS (SELECT 1 FROM accepted)
     LIMIT 1`,

  deferUntilOrder: `UPDATE public.refund_operations
     SET state = 'awaiting_order',
         event_name = $3,
         event_data = $4::jsonb,
         available_at = now() + (
           LEAST(3600, 60 * power(2, LEAST(attempts - 1, 6))) * interval '1 second'
         ),
         claim_token = NULL,
         lease_expires_at = NULL,
         last_error = $5
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state = 'processing'
     RETURNING refund_id`,

  beginLineCreation: `WITH started AS (
       UPDATE public.refund_operations
       SET state = 'creating_line',
           external_idempotency_key = $3,
           lease_expires_at = now() + ($4 * interval '1 second'),
           last_error = NULL
       WHERE refund_id = $1
         AND claim_token = $2::uuid
         AND state = 'processing'
         AND (external_idempotency_key IS NULL OR external_idempotency_key = $3)
       RETURNING true AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key FROM started
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key
     FROM public.refund_operations
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND NOT EXISTS (SELECT 1 FROM started)
     LIMIT 1`,

  markLineCreated: `UPDATE public.refund_operations
     SET state = 'line_created',
         d365_order_number = $3,
         inventory_lot_id = $4,
         line_created_at = now(),
         last_error = NULL
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state = 'creating_line'
     RETURNING refund_id`,

  complete: `UPDATE public.refund_operations
     SET state = 'completed',
         event_data = '{}'::jsonb,
         claim_token = NULL,
         lease_expires_at = NULL,
         d365_order_number = COALESCE($3, d365_order_number),
         inventory_lot_id = COALESCE($4, inventory_lot_id),
         completed_at = now(),
         last_error = NULL
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state IN ('processing', 'line_created')
     RETURNING refund_id`,

  claimRecoveries: `WITH dead_lettered AS (
       UPDATE public.refund_operations
       SET state = 'dead_letter',
           event_data = '{}'::jsonb,
           claim_token = NULL,
           lease_expires_at = NULL,
           resume_state = NULL,
           dead_lettered_at = now(),
           last_error = concat_ws('; ', NULLIF(last_error, ''), 'Recovery attempt limit reached')
       WHERE attempts >= $4
         AND (
           (state = 'awaiting_order' AND available_at <= now())
           OR (
             state IN ('dispatching', 'processing', 'creating_line', 'line_created')
             AND lease_expires_at <= now()
           )
         )
       RETURNING refund_id
     ), candidates AS (
       SELECT refund_id
       FROM public.refund_operations
       WHERE attempts < $4
         AND (
           (state = 'awaiting_order' AND available_at <= now())
           OR (
             state IN ('dispatching', 'processing', 'creating_line', 'line_created')
             AND lease_expires_at <= now()
           )
         )
       ORDER BY available_at, created_at, refund_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE public.refund_operations AS operation
       SET state = 'dispatching',
           resume_state = CASE
             WHEN operation.state = 'awaiting_order' THEN 'processing'
             WHEN operation.state = 'dispatching' THEN operation.resume_state
             ELSE operation.state
           END,
           claim_token = $2::uuid,
           lease_expires_at = now() + ($3 * interval '1 second'),
           attempts = operation.attempts + 1
       FROM candidates
       WHERE operation.refund_id = candidates.refund_id
       RETURNING operation.refund_id
     )
     SELECT
       (SELECT count(*) FROM claimed)::integer AS claimed_count,
       (SELECT count(*) FROM dead_lettered)::integer AS dead_lettered_count`,

  loadRecoveryDispatches: `SELECT refund_id, shopify_order_id, event_name, event_data, attempts
     FROM public.refund_operations
     WHERE state = 'dispatching'
       AND claim_token = $1::uuid
     ORDER BY created_at, refund_id`,
} as const;
