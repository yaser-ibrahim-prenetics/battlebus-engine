BEGIN;

DROP TRIGGER IF EXISTS battle_platform_flow_log_timeline ON public.flow_logs;
DROP FUNCTION IF EXISTS public.battle_platform_capture_flow_log_timeline();

COMMIT;
