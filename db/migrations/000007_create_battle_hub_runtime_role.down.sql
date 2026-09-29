BEGIN;

REVOKE SELECT ON TABLE public.battle_hub_pending_lifecycle_actions FROM battle_hub_runtime;
DROP VIEW IF EXISTS public.battle_hub_pending_lifecycle_actions;
REVOKE USAGE ON SCHEMA public FROM battle_hub_runtime;
DROP ROLE IF EXISTS battle_hub_runtime;

COMMIT;
