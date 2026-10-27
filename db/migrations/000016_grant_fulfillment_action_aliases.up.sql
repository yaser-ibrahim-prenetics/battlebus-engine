ALTER TABLE public.fulfillment_action_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_action_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.fulfillment_action_aliases TO battle_bus_runtime;
CREATE POLICY fulfillment_action_aliases_runtime ON public.fulfillment_action_aliases
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
