DROP POLICY slack_notification_outbox_runtime ON public.slack_notification_outbox;
REVOKE SELECT, INSERT, UPDATE ON public.slack_notification_outbox FROM battle_bus_runtime;
