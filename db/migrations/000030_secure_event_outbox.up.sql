BEGIN;

ALTER TABLE public.event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_outbox FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.event_outbox TO service_role;

CREATE POLICY event_outbox_service_role_all
  ON public.event_outbox
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
