BEGIN;

DROP INDEX IF EXISTS public.idx_reconciliation_history_failed;
DROP INDEX IF EXISTS public.idx_reconciliation_history_range;
DROP INDEX IF EXISTS public.idx_reconciliation_history_type_started;
DROP INDEX IF EXISTS public.idx_reconciliation_history_started;

COMMIT;
