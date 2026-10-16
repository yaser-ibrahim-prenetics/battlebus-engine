BEGIN;

DROP TRIGGER IF EXISTS battle_platform_webhook_inbox_updated_at ON public.webhook_inbox;

COMMIT;
