REVOKE SELECT ON public.battle_hub_pending_lifecycle_actions FROM battle_hub_runtime;
DROP VIEW public.battle_hub_pending_lifecycle_actions;
REVOKE USAGE ON SCHEMA public FROM battle_hub_runtime;
DROP ROLE IF EXISTS battle_hub_runtime;
