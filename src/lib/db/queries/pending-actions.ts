export const pendingActionQueries = {
  store: `INSERT INTO public.pending_lifecycle_actions (
       shopify_order_id,
       shopify_order_name,
       action,
       event_name,
       event_data,
       idempotency_key,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,

  claim: `WITH candidates AS (
       SELECT id
       FROM public.pending_lifecycle_actions
       WHERE (status = 'pending' AND available_at <= now())
          OR (status = 'processing' AND lease_expires_at <= now())
       ORDER BY
         CASE action WHEN 'cancel' THEN 0 WHEN 'refund' THEN 1 ELSE 2 END,
         created_at,
         id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.pending_lifecycle_actions AS pending
     SET status = 'processing',
         claim_token = $2::uuid,
         claimed_at = now(),
         lease_expires_at = now() + ($3 * interval '1 second'),
         attempts = pending.attempts + 1,
         last_error = NULL
     FROM candidates
     WHERE pending.id = candidates.id
     RETURNING pending.id`,

  loadClaimed: `SELECT
       pending.id,
       pending.shopify_order_id,
       pending.shopify_order_name,
       pending.action,
       pending.event_name,
       pending.event_data,
       pending.idempotency_key,
       pending.attempts,
       pending.created_at,
       EXISTS (
         SELECT 1
         FROM public.pending_lifecycle_actions AS cancellation
         WHERE cancellation.shopify_order_id = pending.shopify_order_id
           AND cancellation.action = 'cancel'
           AND cancellation.status IN ('pending', 'processing', 'published')
       ) AS blocked_by_cancellation
     FROM public.pending_lifecycle_actions AS pending
     WHERE pending.status = 'processing'
       AND pending.claim_token = $1::uuid
     ORDER BY
       CASE pending.action WHEN 'cancel' THEN 0 WHEN 'refund' THEN 1 ELSE 2 END,
       pending.created_at,
       pending.id`,

  complete: `UPDATE public.pending_lifecycle_actions
     SET status = CASE
           WHEN id = ANY($2::uuid[]) THEN 'published'
           ELSE 'superseded'
         END,
         event_data = '{}'::jsonb,
         published_at = CASE WHEN id = ANY($2::uuid[]) THEN now() ELSE published_at END,
         superseded_at = CASE WHEN id = ANY($3::uuid[]) THEN now() ELSE superseded_at END,
         last_error = CASE
           WHEN id = ANY($3::uuid[]) THEN 'Superseded by a pending cancellation for the same order'
           ELSE NULL
         END,
         claim_token = NULL,
         lease_expires_at = NULL
     WHERE status = 'processing'
       AND claim_token = $1::uuid
       AND (id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))
     RETURNING id`,
} as const;
