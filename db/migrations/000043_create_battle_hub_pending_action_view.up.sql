DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'battle_hub_runtime') THEN
    CREATE ROLE battle_hub_runtime NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO battle_hub_runtime;
REVOKE ALL ON public.pending_lifecycle_actions FROM battle_hub_runtime;

CREATE VIEW public.battle_hub_pending_lifecycle_actions
WITH (security_barrier = true)
AS
SELECT
  action_id AS id,
  order_id AS shopify_order_id,
  NULLIF(event_data->>'shopifyOrderName', '') AS shopify_order_name,
  action_type AS action,
  event_name,
  CASE status
    WHEN 'queued' THEN 'pending'
    WHEN 'publishing' THEN 'processing'
    WHEN 'dead_letter' THEN 'dead_letter'
  END AS status,
  attempts,
  last_error,
  created_at
FROM public.pending_lifecycle_actions
WHERE status IN ('queued', 'publishing', 'dead_letter');

REVOKE ALL ON public.battle_hub_pending_lifecycle_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_pending_lifecycle_actions TO battle_hub_runtime;

COMMENT ON VIEW public.battle_hub_pending_lifecycle_actions IS
  'Minimal active and dead-letter action projection for Battle Hub; event payloads and completed rows are excluded.';
COMMENT ON ROLE battle_hub_runtime IS
  'NOLOGIN group role inherited by the Battle Hub Cloud Run IAM database user.';
