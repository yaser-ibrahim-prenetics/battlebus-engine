DROP POLICY order_segment_plans_runtime ON public.order_segment_plans;
REVOKE ALL ON public.order_segment_plans FROM battle_bus_runtime;
ALTER TABLE public.order_segment_plans DISABLE ROW LEVEL SECURITY;
