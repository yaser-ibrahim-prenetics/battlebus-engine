DROP POLICY recovery_commands_runtime ON public.recovery_commands;
REVOKE SELECT, INSERT, UPDATE (status,result,error_code,completed_at) ON public.recovery_commands FROM battle_bus_runtime;
