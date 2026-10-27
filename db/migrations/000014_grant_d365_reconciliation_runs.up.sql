ALTER TABLE public.d365_reconciliation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.d365_reconciliation_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.d365_reconciliation_runs TO battle_bus_runtime;
CREATE POLICY d365_reconciliation_runs_runtime ON public.d365_reconciliation_runs
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
