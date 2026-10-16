BEGIN;

CREATE TRIGGER battle_platform_event_outbox_updated_at
  BEFORE UPDATE ON public.event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

COMMIT;
