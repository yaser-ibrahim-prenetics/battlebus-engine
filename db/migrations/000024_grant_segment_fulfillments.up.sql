ALTER TABLE public.order_segment_fulfillments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_segment_fulfillments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.order_segment_fulfillments TO battle_bus_runtime;
CREATE POLICY order_segment_fulfillments_runtime ON public.order_segment_fulfillments
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
