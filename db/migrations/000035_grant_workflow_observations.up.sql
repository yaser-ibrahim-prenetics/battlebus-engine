ALTER TABLE public.workflow_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.workflow_observations TO battle_bus_runtime;
CREATE POLICY workflow_observations_runtime ON public.workflow_observations
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
