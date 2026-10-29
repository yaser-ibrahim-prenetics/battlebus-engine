export const claimPendingActionsSQL = `
WITH supersede_candidates AS (
  SELECT fulfillment.action_id
  FROM public.pending_lifecycle_actions AS fulfillment
  WHERE fulfillment.action_type = 'fulfill'
    AND (
      fulfillment.status = 'queued'
      OR (fulfillment.status = 'publishing' AND fulfillment.lease_expires_at <= now())
    )
    AND EXISTS (
      SELECT 1
      FROM public.pending_lifecycle_actions AS cancellation
      WHERE cancellation.order_id = fulfillment.order_id
        AND cancellation.action_type = 'cancel'
        AND cancellation.status IN ('queued', 'publishing', 'published')
    )
  ORDER BY fulfillment.created_at, fulfillment.action_id
  LIMIT $1
  FOR UPDATE OF fulfillment SKIP LOCKED
), superseded AS (
  UPDATE public.pending_lifecycle_actions AS fulfillment
  SET status = 'superseded',
      superseded_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now(),
      version = fulfillment.version + 1
  FROM supersede_candidates
  WHERE fulfillment.action_id = supersede_candidates.action_id
  RETURNING fulfillment.action_id
), ready AS (
  SELECT queue.action_id
  FROM public.pending_lifecycle_actions AS queue
  WHERE (
      (queue.status = 'queued' AND queue.available_at <= now())
      OR
      (queue.status = 'publishing' AND queue.lease_expires_at <= now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM superseded WHERE superseded.action_id = queue.action_id
    )
    AND NOT (
      queue.action_type = 'fulfill'
      AND EXISTS (
        SELECT 1
        FROM public.pending_lifecycle_actions AS cancellation
        WHERE cancellation.order_id = queue.order_id
          AND cancellation.action_type = 'cancel'
          AND cancellation.status IN ('queued', 'publishing', 'published')
      )
    )
  ORDER BY queue.priority, queue.available_at, queue.created_at, queue.action_id
  LIMIT $1
  FOR UPDATE OF queue SKIP LOCKED
)
UPDATE public.pending_lifecycle_actions AS queue
SET status = 'publishing',
    attempts = queue.attempts + 1,
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + ($2 * interval '1 second'),
    updated_at = now(),
    version = queue.version + 1
FROM ready
WHERE queue.action_id = ready.action_id
RETURNING
  queue.action_id,
  queue.order_id,
  queue.action_type,
  queue.event_name,
  queue.event_data,
  queue.lease_token,
  queue.attempts`;
