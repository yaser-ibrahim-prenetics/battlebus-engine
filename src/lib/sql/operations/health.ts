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
  (SELECT count(*)::int FROM public.reconciliation_attempts WHERE status='running' AND started_at<now()-interval '30 minutes') AS stale_reconciliation_count,
  (SELECT count(*)::int FROM public.oos_recovery_dependencies WHERE status='parked') AS oos_parked_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(first_parked_at)),0)::float8 FROM public.oos_recovery_dependencies WHERE status='parked' AND next_attempt_at<=now() AND (cooldown_until IS NULL OR cooldown_until<=now())) AS oos_due_age_seconds,
  (SELECT count(*)::int FROM public.oos_recovery_dependencies WHERE status='retrying') AS oos_retrying_count,
  (SELECT count(*)::int FROM public.oos_recovery_dependencies WHERE status='manual_review') AS oos_manual_review_count,
  (SELECT count(*)::int FROM public.oos_recovery_dependencies WHERE status='leased' AND lease_until<=now()) AS oos_expired_lease_count,
  (SELECT count(*)::int FROM public.oos_drain_requests WHERE status IN ('queued','leased')) AS oos_open_drain_count,
  (SELECT count(*)::int FROM public.oos_recovery_outbox WHERE status IN ('queued','failed') AND next_attempt_at<=now()) AS oos_outbox_due_count,
  (SELECT count(*)::int FROM public.oos_recovery_outbox WHERE status='failed' AND next_attempt_at='infinity'::timestamptz) AS oos_outbox_exhausted_count,
  (SELECT COALESCE(
    jsonb_object_agg(provider, jsonb_build_object('active', active, 'expired', expired)),
    '{}'::jsonb
  ) FROM (
    SELECT provider,
      count(*) FILTER (WHERE lease_until > clock_timestamp())::int AS active,
      count(*) FILTER (WHERE lease_token IS NOT NULL AND lease_until <= clock_timestamp())::int AS expired
    FROM public.provider_capacity_leases
    GROUP BY provider
  ) AS capacity) AS provider_capacity,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='queued') AS openai_ads_queued_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='retry_wait') AS openai_ads_retry_wait_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='delivering') AS openai_ads_delivering_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='delivering' AND lease_until<=now()) AS openai_ads_expired_lease_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='delivered') AS openai_ads_delivered_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='delivered' AND delivered_at>=now()-interval '24 hours') AS openai_ads_delivered_24h_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='permanent_failure') AS openai_ads_permanent_failure_count,
  (SELECT count(*)::int FROM public.openai_ads_conversions WHERE status='skipped') AS openai_ads_skipped_count,
  (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(next_attempt_at)),0)::float8
    FROM public.openai_ads_conversions
    WHERE status IN ('queued','retry_wait') AND next_attempt_at<=now()) AS openai_ads_oldest_due_age_seconds`;
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
export const openAiAdsSummariesSQL = `SELECT event_id,shopify_store,shopify_order_id,
  conversion_type,occurred_at,status,attempts,next_attempt_at,last_http_status,
  last_error_category,delivered_at,permanent_at,replay_count,replayed_at,created_at,updated_at
  FROM public.openai_ads_conversions ORDER BY created_at DESC LIMIT 50`;
export const channelLiftSummariesSQL = `SELECT run_id,reporting_date,mode,source,status,
  attempts,expected_rows,expected_orders,expected_pairs,mapped_pairs,eligible_events,
  exclusion_counts,batch_count,attempted_events,delivered_events,config_hash,snapshot_hash,
  last_error_code,reason_code,reference_id,started_at,completed_at,created_at,updated_at
  FROM public.channel_lift_runs ORDER BY reporting_date DESC,created_at DESC LIMIT 50`;
