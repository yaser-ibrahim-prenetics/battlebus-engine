DROP POLICY order_segment_fulfillments_runtime ON public.order_segment_fulfillments;
REVOKE ALL ON public.order_segment_fulfillments FROM battle_bus_runtime;
ALTER TABLE public.order_segment_fulfillments DISABLE ROW LEVEL SECURITY;
