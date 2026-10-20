BEGIN;
ALTER TABLE public.workflow_run_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_run_health FROM PUBLIC, anon, authenticated, battle_hub_runtime;
GRANT SELECT, INSERT, UPDATE ON public.workflow_run_health TO service_role;
CREATE POLICY workflow_run_health_service ON public.workflow_run_health TO service_role USING (true) WITH CHECK (true);
COMMIT;

