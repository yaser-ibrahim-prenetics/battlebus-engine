ALTER TABLE public.order_segment_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_segment_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.order_segment_plans TO battle_bus_runtime;
GRANT UPDATE (progress, updated_at) ON public.order_segment_plans TO battle_bus_runtime;
CREATE POLICY order_segment_plans_runtime ON public.order_segment_plans
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
