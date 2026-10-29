DROP POLICY pending_lifecycle_actions_runtime ON public.pending_lifecycle_actions;
REVOKE SELECT, INSERT, UPDATE ON public.pending_lifecycle_actions FROM battle_bus_runtime;
