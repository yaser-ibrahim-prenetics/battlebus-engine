ALTER TABLE public.reconciliation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reconciliation_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reconciliation_attempts TO battle_bus_runtime;
CREATE POLICY reconciliation_attempts_runtime ON public.reconciliation_attempts
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
