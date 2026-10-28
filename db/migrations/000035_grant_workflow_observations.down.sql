DROP POLICY workflow_observations_runtime ON public.workflow_observations;
REVOKE SELECT, INSERT, UPDATE ON public.workflow_observations FROM battle_bus_runtime;
