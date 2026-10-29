const targetOrderSQL = `
  SELECT orders.id
  FROM public.orders
  WHERE orders.shopify_order_id = $1 OR orders.platform_order_id = $1
  ORDER BY
    CASE WHEN orders.shopify_order_id = $1 THEN 0 ELSE 1 END,
    orders.updated_at DESC,
    orders.id
  LIMIT 1`;

function legacyProjectionSQL(enabledExpression: string, additionalPredicate = "true"): string {
  return `
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
  WHERE ${enabledExpression}
    AND ${additionalPredicate}
    AND orders.id = target_order.id
  RETURNING orders.id`;
}

// During the expand/rollback window, every outstanding normalized write is
// projected into orders.pending_actions. Exact completion/supersession removes
// its projection so a rollback cannot replay already-terminal work.
export const enqueuePendingActionSQL = `
WITH existing AS MATERIALIZED (
  SELECT action_id, status
  FROM public.pending_lifecycle_actions
  WHERE order_id = $1
    AND action_type = $2
    AND source_event_id = $3
  LIMIT 1
), target_order AS MATERIALIZED (${targetOrderSQL}
), legacy_projection AS (${legacyProjectionSQL(
  "$7::boolean",
  "NOT EXISTS (SELECT 1 FROM existing WHERE status IN ('published', 'superseded'))"
)}
), queued AS (
  INSERT INTO public.pending_lifecycle_actions (
    order_id,
    action_type,
    source_event_id,
    event_name,
    event_data
  )
  SELECT $1, $2, $3, $4, $5::jsonb
  WHERE NOT $7::boolean
    OR EXISTS (SELECT 1 FROM legacy_projection)
    OR EXISTS (
      SELECT 1 FROM existing WHERE status IN ('published', 'superseded')
    )
  ON CONFLICT (order_id, action_type, source_event_id)
  DO UPDATE SET source_event_id = EXCLUDED.source_event_id
  WHERE pending_lifecycle_actions.status NOT IN ('published', 'superseded')
  RETURNING action_id
), resolved AS (
  SELECT action_id FROM queued
  UNION ALL
  SELECT action_id
  FROM existing
  WHERE status IN ('published', 'superseded')
    AND NOT EXISTS (SELECT 1 FROM queued)
)
SELECT
  resolved.action_id,
  EXISTS (SELECT 1 FROM legacy_projection) AS legacy_projected
FROM resolved`;

export const enqueueLegacyPendingActionSQL = `
WITH target_order AS MATERIALIZED (${targetOrderSQL}
), legacy_projection AS (${legacyProjectionSQL("true")}
)
SELECT id FROM legacy_projection`;
