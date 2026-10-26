// Repeated calls retain the first payload and state for this event ID.
export const enqueueNotificationSQL = `
INSERT INTO public.slack_notification_outbox (notification_id, payload)
VALUES ($1, $2::jsonb)
ON CONFLICT (notification_id) DO NOTHING`;
