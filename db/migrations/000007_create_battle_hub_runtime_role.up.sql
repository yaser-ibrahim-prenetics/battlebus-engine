BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'battle_hub_runtime') THEN
    CREATE ROLE battle_hub_runtime NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO battle_hub_runtime;
REVOKE ALL ON TABLE public.pending_lifecycle_actions FROM battle_hub_runtime;

CREATE VIEW public.battle_hub_pending_lifecycle_actions
WITH (security_barrier = true)
AS
SELECT
  id,
  shopify_order_id,
  shopify_order_name,
  action,
  event_name,
  status,
  attempts,
  last_error,
  created_at
FROM public.pending_lifecycle_actions
WHERE status IN ('pending', 'processing');

REVOKE ALL ON TABLE public.battle_hub_pending_lifecycle_actions FROM PUBLIC;
GRANT SELECT ON TABLE public.battle_hub_pending_lifecycle_actions TO battle_hub_runtime;

COMMENT ON VIEW public.battle_hub_pending_lifecycle_actions IS
  'Minimal active-action projection for Battle Hub; event payloads and terminal rows are excluded.';

COMMENT ON ROLE battle_hub_runtime IS
  'NOLOGIN group role inherited by the Battle Hub Cloud Run IAM database user.';

COMMIT;
