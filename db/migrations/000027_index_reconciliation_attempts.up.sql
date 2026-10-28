CREATE INDEX reconciliation_attempts_recent ON public.reconciliation_attempts (started_at DESC, id);
CREATE INDEX reconciliation_attempts_running ON public.reconciliation_attempts (started_at) WHERE status = 'running';
