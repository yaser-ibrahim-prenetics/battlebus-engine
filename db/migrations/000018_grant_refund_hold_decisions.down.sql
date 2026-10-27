DROP POLICY refund_hold_decisions_insert ON public.refund_hold_decisions;
DROP POLICY refund_hold_decisions_read ON public.refund_hold_decisions;
REVOKE SELECT, INSERT ON public.refund_hold_decisions FROM battle_bus_runtime;
ALTER TABLE public.refund_hold_decisions DISABLE ROW LEVEL SECURITY;
