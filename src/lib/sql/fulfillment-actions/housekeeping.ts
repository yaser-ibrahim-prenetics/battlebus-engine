export const acquireFulfillmentHousekeepingLockSQL = `
SELECT
  pg_try_advisory_xact_lock(
    hashtextextended('battle-bus:fulfillment-action-housekeeping', 0)
  ) AS acquired,
  clock_timestamp() AS started_at`;

export const deleteRetainedTerminalActionsSQL = `
SELECT deleted, aliases_deleted, evidence_deleted
FROM public.delete_retained_fulfillment_actions($1::integer, $2::integer)`;

export const selectDueUnresolvedFulfillmentAlertsSQL = `
WITH due_attempts AS (
  SELECT attempt_id, min(unresolved_since) AS unresolved_since
  FROM public.fulfillment_actions
  WHERE status IN ('pending', 'uncertain')
    AND unresolved_since <= $1::timestamptz - make_interval(hours => $2::int)
    AND (
      last_unresolved_alert_at IS NULL
      OR last_unresolved_alert_at <= $1::timestamptz - make_interval(hours => $3::int)
    )
  GROUP BY attempt_id
  ORDER BY min(unresolved_since), attempt_id
  LIMIT $4
)
SELECT DISTINCT ON (action.attempt_id)
  action.action_key,
  action.attempt_id,
  action.provider,
  action.source_order_id,
  action.action_name,
  action.status,
  action.error_code,
  action.unresolved_since
FROM public.fulfillment_actions AS action
JOIN due_attempts USING (attempt_id)
WHERE action.status IN ('pending', 'uncertain')
  AND action.unresolved_since = due_attempts.unresolved_since
ORDER BY action.attempt_id, action.action_key`;

export const markFulfillmentAttemptAlertedSQL = `
UPDATE public.fulfillment_actions
SET last_unresolved_alert_at = $2::timestamptz
WHERE attempt_id = $1::uuid
  AND status IN ('pending', 'uncertain')
  AND unresolved_since <= $2::timestamptz - make_interval(hours => $3::int)
  AND (
    last_unresolved_alert_at IS NULL
    OR last_unresolved_alert_at <= $2::timestamptz - make_interval(hours => $4::int)
  )
RETURNING action_key`;

export const fulfillmentHousekeepingHasMoreSQL = `
SELECT
  EXISTS (
    SELECT 1 FROM public.fulfillment_actions
    WHERE status IN ('succeeded', 'failed')
      AND updated_at < $1::timestamptz - make_interval(days => $2::int)
  ) AS terminal,
  EXISTS (
    SELECT 1 FROM public.fulfillment_actions
    WHERE status IN ('pending', 'uncertain')
      AND unresolved_since <= $1::timestamptz - make_interval(hours => $3::int)
      AND (
        last_unresolved_alert_at IS NULL
        OR last_unresolved_alert_at <= $1::timestamptz - make_interval(hours => $4::int)
      )
  ) AS unresolved`;
