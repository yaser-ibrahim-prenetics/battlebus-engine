BEGIN;
ALTER TABLE public.workflow_run_health DROP COLUMN sample_excluded;
COMMIT;
