export const queueHealthSQL = `SELECT
  (SELECT count(*)::int FROM public.webhook_inbox WHERE status<>'published') AS inbox_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(received_at)),0)::float8 FROM public.webhook_inbox WHERE status<>'published') AS inbox_age_seconds,
  (SELECT count(DISTINCT attempt_id)::int FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')) AS uncertain_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::float8 FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')) AS uncertain_age_seconds,
  (SELECT count(*)::int FROM public.reconciliation_attempts WHERE status='running' AND started_at<now()-interval '30 minutes') AS stale_reconciliation_count`;
export const inboxSummariesSQL = `SELECT id,source,topic,status,received_at,attempts
  FROM public.webhook_inbox WHERE status<>'published' ORDER BY received_at LIMIT 50`;
export const actionSummariesSQL = `SELECT attempt_id,provider,scope,source_order_id,action_name,status,
  min(created_at) AS created_at, count(*)::int AS line_count, bool_and(recovery_context IS NOT NULL) AS has_recovery_context
  FROM public.fulfillment_actions WHERE status IN ('pending','uncertain')
  GROUP BY attempt_id,provider,scope,source_order_id,action_name,status ORDER BY min(created_at) LIMIT 50`;
