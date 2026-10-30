BEGIN;
ALTER TABLE public.workflow_run_health ADD COLUMN sample_excluded boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.workflow_run_health.sample_excluded IS
  'Skipped, simulated or deferred invocations are retained but excluded from completed SLO samples.';
COMMIT;
