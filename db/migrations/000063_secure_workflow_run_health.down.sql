BEGIN;
DROP POLICY workflow_run_health_service ON public.workflow_run_health;
REVOKE SELECT, INSERT, UPDATE ON public.workflow_run_health FROM service_role;
ALTER TABLE public.workflow_run_health DISABLE ROW LEVEL SECURITY;
COMMIT;
