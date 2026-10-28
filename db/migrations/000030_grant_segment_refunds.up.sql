ALTER TABLE public.order_segment_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_segment_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.order_segment_refunds TO battle_bus_runtime;
CREATE POLICY order_segment_refunds_runtime ON public.order_segment_refunds
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
