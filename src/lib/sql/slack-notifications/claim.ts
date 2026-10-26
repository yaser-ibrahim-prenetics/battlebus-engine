// Expired claims are safe to republish: the consumer deduplicates by notification ID.
export const claimNotificationsSQL = `
WITH ready AS (
  SELECT notification_id FROM public.slack_notification_outbox
  WHERE status IN ('pending', 'publishing') AND available_at <= now()
    AND ($2::text IS NULL OR notification_id = $2)
  ORDER BY available_at, created_at
  LIMIT $1 FOR UPDATE SKIP LOCKED
)
UPDATE public.slack_notification_outbox AS queue
SET status = 'publishing', attempts = attempts + 1,
    lease_token = gen_random_uuid(), available_at = now() + interval '2 minutes'
FROM ready WHERE queue.notification_id = ready.notification_id
RETURNING queue.notification_id, queue.payload, queue.lease_token, queue.attempts`;
