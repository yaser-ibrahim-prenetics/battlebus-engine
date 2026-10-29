DROP POLICY backorder_recovery_leases_runtime ON public.backorder_recovery_leases;
REVOKE SELECT, INSERT, UPDATE ON public.backorder_recovery_leases FROM battle_bus_runtime;
DROP TABLE public.backorder_recovery_leases;
