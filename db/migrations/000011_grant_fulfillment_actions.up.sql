ALTER TABLE public.fulfillment_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.fulfillment_actions TO battle_bus_runtime;
CREATE POLICY fulfillment_actions_runtime ON public.fulfillment_actions
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
