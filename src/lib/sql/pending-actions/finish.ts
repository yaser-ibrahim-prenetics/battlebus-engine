export const completePendingActionSQL = `
UPDATE public.pending_lifecycle_actions
SET status = 'published',
    published_at = now(),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = now(),
    version = version + 1
WHERE action_id = $1
  AND lease_token = $2
  AND status = 'publishing'
RETURNING action_id`;

export const retryPendingActionSQL = `
UPDATE public.pending_lifecycle_actions
SET status = CASE WHEN attempts >= $3 THEN 'dead_letter' ELSE 'queued' END,
    available_at = now() + (
      LEAST(3600, power(2, LEAST(attempts, 12))) * interval '1 second'
    ),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = 'Inngest event publication failed',
    updated_at = now(),
    version = version + 1
WHERE action_id = $1
  AND lease_token = $2
  AND status = 'publishing'
RETURNING action_id, status`;
