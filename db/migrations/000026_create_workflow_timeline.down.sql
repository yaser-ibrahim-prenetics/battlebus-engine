BEGIN;

DROP TRIGGER IF EXISTS battle_platform_flow_log_timeline ON public.flow_logs;
DROP TRIGGER IF EXISTS battle_platform_event_outbox_timeline ON public.event_outbox;
DROP FUNCTION IF EXISTS public.battle_platform_capture_flow_log_timeline();
DROP FUNCTION IF EXISTS public.battle_platform_capture_outbox_timeline();
DROP TABLE IF EXISTS public.workflow_timeline_events;

COMMIT;
