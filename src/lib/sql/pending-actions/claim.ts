export const claimPendingActionsSQL = `
WITH expired_candidates AS (
  SELECT queue.action_id
  FROM public.pending_lifecycle_actions AS queue
  WHERE queue.status = 'publishing'
    AND queue.lease_expires_at <= now()
  ORDER BY queue.lease_expires_at, queue.created_at, queue.action_id
  LIMIT $1
  FOR UPDATE OF queue SKIP LOCKED
), recovered AS (
  UPDATE public.pending_lifecycle_actions AS queue
  SET status = CASE WHEN queue.attempts >= $3 THEN 'dead_letter' ELSE 'queued' END,
      available_at = now() + (
        LEAST(3600, power(2, LEAST(queue.attempts, 12))) * interval '1 second'
      ),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = 'Pending action lease expired before acknowledgement',
      updated_at = now(),
      version = queue.version + 1
  FROM expired_candidates
  WHERE queue.action_id = expired_candidates.action_id
  RETURNING queue.action_id
), supersede_candidates AS (
  SELECT fulfillment.action_id
  FROM public.pending_lifecycle_actions AS fulfillment
  WHERE fulfillment.action_type = 'fulfill'
    AND NOT EXISTS (
      SELECT 1 FROM recovered WHERE recovered.action_id = fulfillment.action_id
    )
    AND (
      fulfillment.status = 'queued'
      OR (fulfillment.status = 'publishing' AND fulfillment.lease_expires_at <= now())
    )
    AND EXISTS (
      SELECT 1
      FROM public.pending_lifecycle_actions AS cancellation
      WHERE cancellation.order_id = fulfillment.order_id
        AND cancellation.action_type = 'cancel'
        AND cancellation.status IN ('queued', 'publishing', 'published', 'dead_letter')
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
    )
    AND NOT EXISTS (
      SELECT 1 FROM recovered WHERE recovered.action_id = queue.action_id
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
          AND cancellation.status IN ('queued', 'publishing', 'published', 'dead_letter')
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
