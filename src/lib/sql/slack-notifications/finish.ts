export const completeNotificationSQL = `
UPDATE public.slack_notification_outbox
SET status = 'published', published_at = now(), lease_token = NULL, last_error = NULL
WHERE notification_id = $1 AND lease_token = $2 AND status = 'publishing'`;

export const retryNotificationSQL = `
UPDATE public.slack_notification_outbox
SET status = CASE WHEN attempts >= 10 THEN 'dead_letter' ELSE 'pending' END,
    available_at = now() + (LEAST(3600, power(2, LEAST(attempts, 12))) * interval '1 second'),
    lease_token = NULL, last_error = 'Notification transport publication failed'
WHERE notification_id = $1 AND lease_token = $2 AND status = 'publishing'`;
