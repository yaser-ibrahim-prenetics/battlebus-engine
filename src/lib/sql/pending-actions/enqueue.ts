// During the expand/rollback window, every normalized write is also projected
// into orders.pending_actions. The projection is intentionally retained until
// a later contract migration proves that no rollback-capable revision uses it.
export const enqueuePendingActionSQL = `
WITH target_order AS MATERIALIZED (
  SELECT orders.id
  FROM public.orders
  WHERE orders.shopify_order_id = $1 OR orders.platform_order_id = $1
  ORDER BY
    CASE WHEN orders.shopify_order_id = $1 THEN 0 ELSE 1 END,
    orders.updated_at DESC,
    orders.id
  LIMIT 1
), legacy_projection AS (
  UPDATE public.orders AS orders
  SET pending_actions = CASE
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(orders.pending_actions) AS item(action)
          WHERE item.action->>'sourceEventId' = $3
            AND item.action->>'action' = $2
        ) THEN orders.pending_actions
        ELSE orders.pending_actions || jsonb_build_array($6::jsonb)
      END,
      updated_at = now()
  FROM target_order
  WHERE $7::boolean
    AND orders.id = target_order.id
  RETURNING orders.id
), queued AS (
  INSERT INTO public.pending_lifecycle_actions (
    order_id,
    action_type,
    source_event_id,
    event_name,
    event_data
  )
  SELECT $1, $2, $3, $4, $5::jsonb
  WHERE NOT $7::boolean OR EXISTS (SELECT 1 FROM legacy_projection)
  ON CONFLICT (order_id, action_type, source_event_id)
  DO UPDATE SET source_event_id = EXCLUDED.source_event_id
  RETURNING action_id
)
SELECT
  queued.action_id,
  EXISTS (SELECT 1 FROM legacy_projection) AS legacy_projected
FROM queued`;

export const enqueueLegacyPendingActionSQL = `
WITH target_order AS MATERIALIZED (
  SELECT orders.id
  FROM public.orders
  WHERE orders.shopify_order_id = $1 OR orders.platform_order_id = $1
  ORDER BY
    CASE WHEN orders.shopify_order_id = $1 THEN 0 ELSE 1 END,
    orders.updated_at DESC,
    orders.id
  LIMIT 1
)
UPDATE public.orders AS orders
SET pending_actions = CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(orders.pending_actions) AS item(action)
        WHERE item.action->>'sourceEventId' = $2
          AND item.action->>'action' = $3
      ) THEN orders.pending_actions
      ELSE orders.pending_actions || jsonb_build_array($4::jsonb)
    END,
    updated_at = now()
FROM target_order
WHERE orders.id = target_order.id
RETURNING orders.id`;
