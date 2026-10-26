CREATE INDEX slack_notification_outbox_ready_idx
  ON public.slack_notification_outbox (available_at, created_at)
  WHERE status IN ('pending', 'publishing');
