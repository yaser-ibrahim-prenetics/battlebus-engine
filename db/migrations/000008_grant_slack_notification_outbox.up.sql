ALTER TABLE public.slack_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slack_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.slack_notification_outbox TO battle_bus_runtime;
CREATE POLICY slack_notification_outbox_runtime
  ON public.slack_notification_outbox FOR ALL TO battle_bus_runtime
  USING (true) WITH CHECK (true);
