BEGIN;

CREATE VIEW public.battle_hub_workflow_timeline
WITH (security_barrier = true)
AS
SELECT
  id,
  shopify_order_id,
  shopify_order_name,
  source,
  event_type,
  stage,
  status,
  message,
  run_id,
  error_class,
  recovery_action,
  metadata,
  occurred_at
FROM public.workflow_timeline_events;

REVOKE ALL ON TABLE public.battle_hub_workflow_timeline FROM PUBLIC;
GRANT SELECT ON TABLE public.battle_hub_workflow_timeline TO battle_hub_runtime;

COMMENT ON VIEW public.battle_hub_workflow_timeline IS
  'Read-only, payload-safe per-order workflow timeline consumed by Battle Hub.';

COMMIT;
