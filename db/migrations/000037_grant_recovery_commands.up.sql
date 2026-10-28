ALTER TABLE public.recovery_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recovery_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.recovery_commands TO battle_bus_runtime;
GRANT UPDATE (status,result,error_code,completed_at) ON public.recovery_commands TO battle_bus_runtime;
CREATE POLICY recovery_commands_runtime ON public.recovery_commands
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
