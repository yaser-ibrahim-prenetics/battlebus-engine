// This expand-phase bridge atomically snapshots and clears only fully valid legacy arrays.
// A concurrent append waits for the row lock and remains available for the next sweep.
export const importLegacyPendingActionsSQL = `
WITH legacy_orders AS MATERIALIZED (
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
      WHERE item.action->>'action' NOT IN ('cancel', 'refund', 'fulfill')
        OR length(btrim(COALESCE(item.action->>'eventName', ''))) NOT BETWEEN 1 AND 255
        OR jsonb_typeof(item.action->'eventData') IS DISTINCT FROM 'object'
    )
  ORDER BY orders.updated_at, orders.id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
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
    'legacy:' || md5(legacy_actions.action::text),
    legacy_actions.action->>'eventName',
    legacy_actions.action->'eventData'
  FROM legacy_actions
  ON CONFLICT (order_id, action_type, source_event_id) DO NOTHING
  RETURNING action_id
), cleared AS (
  UPDATE public.orders AS orders
  SET pending_actions = '[]'::jsonb,
      updated_at = now()
  FROM legacy_orders
  WHERE orders.id = legacy_orders.id
  RETURNING orders.id
)
SELECT
  (SELECT count(*) FROM inserted) AS imported,
  (SELECT count(*) FROM cleared) AS cleared_orders`;
