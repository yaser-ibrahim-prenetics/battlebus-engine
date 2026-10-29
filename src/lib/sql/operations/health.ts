export const queueHealthSQL = `SELECT
  (SELECT count(*)::int FROM public.webhook_inbox WHERE status<>'published') AS inbox_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(received_at)),0)::float8 FROM public.webhook_inbox WHERE status<>'published' AND dead_lettered_at IS NULL AND lease_token IS NULL AND next_attempt_at<=now()) AS inbox_age_seconds,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE dead_lettered_at IS NOT NULL) AS inbox_dead_letter_count,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE lease_token IS NOT NULL) AS inbox_leased_count,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE lease_token IS NOT NULL AND lease_expires_at<=now()) AS inbox_expired_lease_count,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE status<>'published' AND dead_lettered_at IS NULL AND lease_token IS NULL AND next_attempt_at>now()) AS inbox_backoff_count,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE status<>'published' AND dead_lettered_at IS NULL AND lease_token IS NULL AND next_attempt_at<=now()) AS inbox_due_count,
  (SELECT count(*)::int FROM public.webhook_inbox WHERE status='published' AND published_at>=now()-interval '24 hours') AS inbox_published_24h_count,
  (SELECT COALESCE(sum(GREATEST(attempts-1,0)),0)::bigint FROM public.webhook_inbox) AS inbox_retry_attempt_count,
  (SELECT count(DISTINCT attempt_id)::int FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')) AS uncertain_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::float8 FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')) AS uncertain_age_seconds,
  (SELECT count(*)::int FROM public.reconciliation_attempts WHERE status='running' AND started_at<now()-interval '30 minutes') AS stale_reconciliation_count`;
export const inboxSummariesSQL = `SELECT id,source,topic,
  CASE
    WHEN dead_lettered_at IS NOT NULL THEN 'dead_letter'
    WHEN lease_token IS NOT NULL THEN 'processing'
    ELSE status
  END AS status,
  received_at,attempts,replay_count,next_attempt_at,lease_expires_at,dead_lettered_at,last_error
  FROM public.webhook_inbox WHERE status<>'published' ORDER BY received_at DESC LIMIT 50`;
export const actionSummariesSQL = `SELECT attempt_id,provider,scope,source_order_id,action_name,status,
  min(created_at) AS created_at, count(*)::int AS line_count, bool_and(recovery_context IS NOT NULL) AS has_recovery_context
  FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')
  GROUP BY attempt_id,provider,scope,source_order_id,action_name,status ORDER BY min(created_at) DESC LIMIT 50`;
