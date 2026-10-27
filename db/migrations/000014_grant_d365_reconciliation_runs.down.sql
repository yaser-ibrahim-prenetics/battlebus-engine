DROP POLICY d365_reconciliation_runs_runtime ON public.d365_reconciliation_runs;
REVOKE SELECT, INSERT, UPDATE ON public.d365_reconciliation_runs FROM battle_bus_runtime;
