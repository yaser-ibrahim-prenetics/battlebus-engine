// Expand-phase copy: legacy data remains intact for rollback-capable revisions.
// Rows already represented in the normalized queue are skipped, so a retained
// projection cannot starve newer legacy writes from the bounded import window.
// The snapshot deliberately does not lock orders: queue operations use a
// queue-before-order lock order, and a concurrent legacy append is copied by a
// later sweep.
export const importLegacyPendingActionsSQL = `
WITH poison_orders AS MATERIALIZED (
  SELECT orders.id
  FROM public.orders
  WHERE jsonb_typeof(orders.pending_actions) = 'array'
    AND jsonb_array_length(orders.pending_actions) > 0
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(orders.pending_actions) AS item(action)
      WHERE COALESCE(item.action->>'action', '') NOT IN ('cancel', 'refund', 'fulfill')
        OR length(btrim(COALESCE(item.action->>'eventName', ''))) NOT BETWEEN 1 AND 255
        OR jsonb_typeof(item.action->'eventData') IS DISTINCT FROM 'object'
        OR octet_length((item.action->'eventData')::text) > 524288
        OR length(btrim(COALESCE(item.action->>'sourceEventId', ''))) > 1024
    )
  ORDER BY orders.updated_at, orders.id
  LIMIT $1
), legacy_orders AS MATERIALIZED (
  SELECT
    orders.id,
    COALESCE(
      NULLIF(btrim(orders.shopify_order_id), ''),
      NULLIF(btrim(orders.platform_order_id), ''),
      orders.id::text
    ) AS order_id,
    orders.pending_actions
  FROM public.orders
  WHERE jsonb_typeof(orders.pending_actions) = 'array'
    AND jsonb_array_length(orders.pending_actions) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(orders.pending_actions) AS item(action)
      WHERE COALESCE(item.action->>'action', '') NOT IN ('cancel', 'refund', 'fulfill')
        OR length(btrim(COALESCE(item.action->>'eventName', ''))) NOT BETWEEN 1 AND 255
        OR jsonb_typeof(item.action->'eventData') IS DISTINCT FROM 'object'
        OR octet_length((item.action->'eventData')::text) > 524288
        OR length(btrim(COALESCE(item.action->>'sourceEventId', ''))) > 1024
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(orders.pending_actions) AS item(action)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.pending_lifecycle_actions AS normalized
        WHERE normalized.order_id = COALESCE(
            NULLIF(btrim(orders.shopify_order_id), ''),
            NULLIF(btrim(orders.platform_order_id), ''),
            orders.id::text
          )
          AND normalized.action_type = item.action->>'action'
          AND normalized.source_event_id = COALESCE(
            NULLIF(btrim(item.action->>'sourceEventId'), ''),
            'legacy:' || md5(item.action::text)
          )
      )
    )
  ORDER BY orders.updated_at, orders.id
  LIMIT $1
), legacy_actions AS (
  SELECT legacy_orders.id AS order_row_id,
         legacy_orders.order_id,
         item.action
  FROM legacy_orders
  CROSS JOIN LATERAL jsonb_array_elements(legacy_orders.pending_actions) AS item(action)
), inserted AS (
  INSERT INTO public.pending_lifecycle_actions (
    order_id,
    action_type,
    source_event_id,
    event_name,
    event_data
  )
  SELECT
    legacy_actions.order_id,
    legacy_actions.action->>'action',
    COALESCE(
      NULLIF(btrim(legacy_actions.action->>'sourceEventId'), ''),
      'legacy:' || md5(legacy_actions.action::text)
    ),
    legacy_actions.action->>'eventName',
    legacy_actions.action->'eventData'
  FROM legacy_actions
  ON CONFLICT (order_id, action_type, source_event_id) DO NOTHING
  RETURNING action_id
)
SELECT
  (SELECT count(*) FROM inserted) AS imported,
  (SELECT count(*) FROM legacy_orders) AS source_orders,
  (SELECT count(*) FROM poison_orders) AS poison_orders`;
