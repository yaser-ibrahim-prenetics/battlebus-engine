DROP POLICY reconciliation_attempts_runtime ON public.reconciliation_attempts;
REVOKE SELECT, INSERT, UPDATE ON public.reconciliation_attempts FROM battle_bus_runtime;
