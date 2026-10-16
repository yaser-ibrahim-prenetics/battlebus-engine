BEGIN;

CREATE INDEX IF NOT EXISTS idx_reconciliation_history_started
  ON public.reconciliation_history (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_history_type_started
  ON public.reconciliation_history (reconciliation_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_history_range
  ON public.reconciliation_history (date_from, date_to, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_history_failed
  ON public.reconciliation_history (completed_at DESC)
  WHERE status = 'failed';

COMMIT;
