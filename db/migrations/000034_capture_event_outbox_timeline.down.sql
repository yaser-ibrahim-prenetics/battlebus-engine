BEGIN;

DROP TRIGGER IF EXISTS battle_platform_event_outbox_timeline ON public.event_outbox;
DROP FUNCTION IF EXISTS public.battle_platform_capture_outbox_timeline();

COMMIT;
