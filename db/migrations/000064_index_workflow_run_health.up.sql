BEGIN;
CREATE INDEX workflow_run_health_window ON public.workflow_run_health (revision, started_at, function_id);
CREATE INDEX workflow_run_health_backlog ON public.workflow_run_health (received_at) WHERE status = 'running';
COMMIT;
