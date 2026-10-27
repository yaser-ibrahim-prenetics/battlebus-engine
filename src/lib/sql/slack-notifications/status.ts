export const notificationStatusSQL = `
SELECT status FROM public.slack_notification_outbox WHERE notification_id = $1`;
