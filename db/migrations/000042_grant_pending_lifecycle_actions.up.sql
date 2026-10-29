ALTER TABLE public.pending_lifecycle_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_lifecycle_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pending_lifecycle_actions TO battle_bus_runtime;
CREATE POLICY pending_lifecycle_actions_runtime
  ON public.pending_lifecycle_actions FOR ALL TO battle_bus_runtime
  USING (true) WITH CHECK (true);
