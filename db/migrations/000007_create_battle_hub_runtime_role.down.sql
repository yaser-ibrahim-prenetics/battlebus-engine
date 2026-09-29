BEGIN;

DROP POLICY IF EXISTS pending_lifecycle_actions_battle_hub_read
  ON public.pending_lifecycle_actions;
REVOKE SELECT ON TABLE public.pending_lifecycle_actions FROM battle_hub_runtime;
REVOKE USAGE ON SCHEMA public FROM battle_hub_runtime;
DROP ROLE IF EXISTS battle_hub_runtime;

COMMIT;
