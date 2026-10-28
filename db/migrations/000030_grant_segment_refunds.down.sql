DROP POLICY order_segment_refunds_runtime ON public.order_segment_refunds;
REVOKE SELECT, INSERT, UPDATE ON public.order_segment_refunds FROM battle_bus_runtime;
