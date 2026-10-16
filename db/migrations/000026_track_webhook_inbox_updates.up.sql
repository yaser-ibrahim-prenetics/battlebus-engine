BEGIN;

CREATE TRIGGER battle_platform_webhook_inbox_updated_at
  BEFORE UPDATE ON public.webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

COMMIT;
