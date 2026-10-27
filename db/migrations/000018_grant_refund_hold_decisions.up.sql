ALTER TABLE public.refund_hold_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_hold_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.refund_hold_decisions TO battle_bus_runtime;
CREATE POLICY refund_hold_decisions_read ON public.refund_hold_decisions
  FOR SELECT TO battle_bus_runtime USING (true);
CREATE POLICY refund_hold_decisions_insert ON public.refund_hold_decisions
  FOR INSERT TO battle_bus_runtime WITH CHECK (true);
