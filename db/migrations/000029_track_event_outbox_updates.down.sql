BEGIN;

DROP TRIGGER IF EXISTS battle_platform_event_outbox_updated_at ON public.event_outbox;

COMMIT;
