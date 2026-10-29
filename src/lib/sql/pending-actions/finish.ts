export const completePendingActionSQL = `
WITH completed AS (
  UPDATE public.pending_lifecycle_actions
  SET status = 'published',
      published_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = now()
  WHERE action_id = $1
    AND lease_token = $2
    AND status = 'publishing'
  RETURNING action_id, order_id, action_type, source_event_id
), legacy_projection AS (
  UPDATE public.orders AS orders
  SET pending_actions = (
        SELECT COALESCE(
          jsonb_agg(item.action ORDER BY item.ordinality),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(orders.pending_actions)
          WITH ORDINALITY AS item(action, ordinality)
        WHERE (
          item.action->>'action' = completed.action_type
          AND (
            item.action->>'sourceEventId' = completed.source_event_id
            OR (
              NULLIF(btrim(item.action->>'sourceEventId'), '') IS NULL
              AND 'legacy:' || md5(item.action::text) = completed.source_event_id
            )
          )
        ) IS NOT TRUE
      ),
      updated_at = now()
  FROM completed
  WHERE orders.shopify_order_id = completed.order_id
     OR orders.platform_order_id = completed.order_id
  RETURNING orders.id
)
SELECT
  completed.action_id,
  (SELECT count(*) FROM legacy_projection) AS legacy_orders_updated
FROM completed`;

export const retryPendingActionSQL = `
UPDATE public.pending_lifecycle_actions
SET status = CASE WHEN attempts >= $3 THEN 'dead_letter' ELSE 'queued' END,
    available_at = now() + (
      LEAST(3600, power(2, LEAST(attempts, 12))) * interval '1 second'
    ),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = 'Inngest event publication failed',
    updated_at = now()
WHERE action_id = $1
  AND lease_token = $2
  AND status = 'publishing'
RETURNING action_id, status`;
