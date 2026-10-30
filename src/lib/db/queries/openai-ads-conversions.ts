export const openAiAdsConversionQueries = {
  enqueue: `INSERT INTO public.openai_ads_conversions (
       event_id, shopify_store, shopify_order_id, conversion_type, occurred_at,
       status, last_error_category, permanent_at
     )
     VALUES ($1, $2, $3, 'order_created', $4::timestamptz, $5, $6, $7::timestamptz)
     ON CONFLICT DO NOTHING
     RETURNING event_id, status, attempts, last_error_category`,

  getByIdentity: `SELECT event_id, status, attempts, last_error_category
     FROM public.openai_ads_conversions
     WHERE shopify_store = $1
       AND shopify_order_id = $2
       AND conversion_type = 'order_created'`,

  claimDue: `WITH candidates AS (
       SELECT event_id
       FROM public.openai_ads_conversions
       WHERE (
           status IN ('queued', 'retry_wait')
           AND next_attempt_at <= clock_timestamp()
           AND attempts < $4
         ) OR (
           status = 'delivering'
           AND lease_until <= clock_timestamp()
         )
       ORDER BY next_attempt_at, created_at, event_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.openai_ads_conversions AS conversion
     SET status = 'delivering',
         lease_token = $2::uuid,
         lease_until = clock_timestamp() + make_interval(secs => $3),
         attempts = CASE
           WHEN conversion.status = 'delivering' THEN conversion.attempts
           ELSE conversion.attempts + 1
         END,
         last_error_category = CASE
           WHEN conversion.status = 'delivering' THEN 'lease_expired'
           ELSE conversion.last_error_category
         END,
         last_error = CASE
           WHEN conversion.status = 'delivering'
             THEN 'Previous delivery lease expired; retrying the same attempt'
           ELSE conversion.last_error
         END
     FROM candidates
     WHERE conversion.event_id = candidates.event_id
     RETURNING conversion.event_id, conversion.shopify_store,
       conversion.shopify_order_id, conversion.occurred_at, conversion.attempts,
       conversion.lease_token, conversion.lease_until`,

  renewClaim: `UPDATE public.openai_ads_conversions
     SET lease_until = clock_timestamp() + make_interval(secs => $3)
     WHERE event_id = $1
       AND lease_token = $2::uuid
       AND status = 'delivering'
       AND lease_until > clock_timestamp()
     RETURNING lease_until`,

  markDelivered: `UPDATE public.openai_ads_conversions
     SET status = 'delivered',
         lease_token = NULL,
         lease_until = NULL,
         delivered_at = clock_timestamp(),
         permanent_at = NULL,
         last_http_status = $3,
         last_error_category = NULL,
         last_error = NULL
     WHERE event_id = $1
       AND lease_token = $2::uuid
       AND status = 'delivering'
     RETURNING event_id`,

  markFailed: `UPDATE public.openai_ads_conversions
     SET status = CASE WHEN $4::boolean THEN 'permanent_failure' ELSE 'retry_wait' END,
         lease_token = NULL,
         lease_until = NULL,
         next_attempt_at = CASE
           WHEN $4::boolean THEN next_attempt_at
           ELSE clock_timestamp() + make_interval(secs => $5)
         END,
         last_http_status = $3,
         last_error_category = $6,
         last_error = $7,
         permanent_at = CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END
     WHERE event_id = $1
       AND lease_token = $2::uuid
       AND status = 'delivering'
     RETURNING event_id, status, next_attempt_at`,

  replay: `UPDATE public.openai_ads_conversions
     SET status = 'queued',
         attempts = 0,
         next_attempt_at = clock_timestamp(),
         lease_token = NULL,
         lease_until = NULL,
         last_http_status = NULL,
         last_error_category = NULL,
         last_error = NULL,
         permanent_at = NULL,
         replay_count = replay_count + 1,
         replayed_at = clock_timestamp()
     WHERE event_id = $1
       AND status IN ('permanent_failure', 'skipped')
       AND replay_count < 100
     RETURNING event_id, status, replay_count`,
} as const;
