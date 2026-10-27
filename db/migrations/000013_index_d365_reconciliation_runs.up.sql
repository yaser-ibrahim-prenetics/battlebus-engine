CREATE INDEX d365_reconciliation_runs_window ON public.d365_reconciliation_runs (kind, range_start, range_end);
CREATE INDEX d365_reconciliation_runs_workflow ON public.d365_reconciliation_runs (workflow_run_id, started_at);
