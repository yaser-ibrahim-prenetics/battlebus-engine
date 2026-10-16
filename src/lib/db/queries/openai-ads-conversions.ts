export const openAiAdsConversionQueries = {
  enqueue: `INSERT INTO public.openai_ads_conversions (
       event_id, shopify_order_id, shopify_order_name, occurred_at
     )
     VALUES ($1, $2, $3, $4::timestamptz)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id, state
     `,

  getByEventId: `SELECT event_id, state
     FROM public.openai_ads_conversions
     WHERE event_id = $1`,

  claimDue: `WITH dead_lettered AS (
       UPDATE public.openai_ads_conversions
       SET state = 'dead_letter',
           claim_token = NULL,
           lease_expires_at = NULL,
           dead_lettered_at = now(),
           updated_at = now(),
           last_error = concat_ws('; ', NULLIF(last_error, ''), 'Delivery attempt limit reached')
       WHERE attempts >= $4
         AND ($5::text IS NULL OR event_id = $5)
         AND (
           (state = 'pending' AND available_at <= now())
           OR (state = 'delivering' AND lease_expires_at <= now())
         )
       RETURNING event_id
     ), candidates AS (
       SELECT event_id
       FROM public.openai_ads_conversions
       WHERE attempts < $4
         AND ($5::text IS NULL OR event_id = $5)
         AND (
           (state = 'pending' AND available_at <= now())
           OR (state = 'delivering' AND lease_expires_at <= now())
         )
       ORDER BY available_at, created_at, event_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE public.openai_ads_conversions AS conversion
       SET state = 'delivering',
           claim_token = $2::uuid,
           lease_expires_at = now() + ($3 * interval '1 second'),
           attempts = conversion.attempts + 1,
           updated_at = now()
       FROM candidates
       WHERE conversion.event_id = candidates.event_id
       RETURNING conversion.event_id,
         conversion.shopify_order_id,
         conversion.shopify_order_name,
         conversion.occurred_at,
         conversion.attempts,
         conversion.claim_token
     )
     SELECT * FROM claimed
     ORDER BY event_id`,

  claimForRedelivery: `UPDATE public.openai_ads_conversions
     SET state = 'delivering',
         claim_token = $2::uuid,
         lease_expires_at = now() + ($3 * interval '1 second'),
         attempts = 1,
         available_at = now(),
         delivered_at = NULL,
         dead_lettered_at = NULL,
         updated_at = now()
     WHERE event_id = $1
       AND (
         state IN ('pending', 'dead_letter')
         OR (state = 'delivering' AND lease_expires_at <= now())
       )
     RETURNING event_id,
       shopify_order_id,
       shopify_order_name,
       occurred_at,
       attempts,
       claim_token`,

  markDelivered: `UPDATE public.openai_ads_conversions
     SET state = 'delivered',
         claim_token = NULL,
         lease_expires_at = NULL,
         delivered_at = now(),
         last_http_status = $3,
         last_error = NULL,
         updated_at = now()
     WHERE event_id = $1
       AND claim_token = $2::uuid
       AND state = 'delivering'
     RETURNING event_id`,

  markFailed: `UPDATE public.openai_ads_conversions
     SET state = CASE WHEN $4::boolean THEN 'dead_letter' ELSE 'pending' END,
         claim_token = NULL,
         lease_expires_at = NULL,
         available_at = CASE
           WHEN $4::boolean THEN available_at
           ELSE now() + ($5 * interval '1 millisecond')
         END,
         last_http_status = $3,
         last_error = $6,
         dead_lettered_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
         updated_at = now()
     WHERE event_id = $1
       AND claim_token = $2::uuid
       AND state = 'delivering'
     RETURNING event_id, state, available_at`,
} as const;
