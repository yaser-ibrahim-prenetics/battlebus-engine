BEGIN;

WITH completed_refunds AS (
  SELECT DISTINCT ON (refund_id)
    refund_id,
    COALESCE(shopify_order_id, 'unknown') AS shopify_order_id,
    d365_order_number,
    inventory_lot_id,
    completed_at
  FROM (
    SELECT
      NULLIF(btrim(payload->>'refundId'), '') AS refund_id,
      COALESCE(
        NULLIF(btrim(shopify_order_id), ''),
        NULLIF(btrim(payload->>'shopifyOrderId'), '')
      ) AS shopify_order_id,
      COALESCE(
        NULLIF(btrim(d365_order_number), ''),
        NULLIF(btrim(payload->>'d365OrderNumber'), '')
      ) AS d365_order_number,
      COALESCE(
        NULLIF(btrim(payload->>'inventoryLotId'), ''),
        NULLIF(btrim(payload->>'lotId'), '')
      ) AS inventory_lot_id,
      ts AS completed_at
    FROM public.flow_logs
    WHERE flow = 'refund'
      AND step IN ('refund_line_created', 'done')
      AND status = 'completed'
  ) AS historical
  WHERE refund_id IS NOT NULL
  ORDER BY refund_id, completed_at DESC
)
INSERT INTO public.refund_operations (
  refund_id,
  shopify_order_id,
  event_data,
  state,
  d365_order_number,
  inventory_lot_id,
  line_created_at,
  completed_at,
  backfilled_at
)
SELECT
  refund_id,
  shopify_order_id,
  '{}'::jsonb,
  'completed',
  d365_order_number,
  inventory_lot_id,
  completed_at,
  completed_at,
  now()
FROM completed_refunds
ON CONFLICT (refund_id) DO NOTHING;

COMMIT;
