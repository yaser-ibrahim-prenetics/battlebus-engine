INSERT INTO public.pending_lifecycle_actions (
  shopify_order_id, action, event_name, event_data, idempotency_key, status
)
VALUES
  ('migration-active', 'refund', 'shopify/order.refunded', '{"private":"active"}', 'migration-active', 'pending'),
  ('migration-terminal', 'cancel', 'shopify/order.cancelled', '{"private":"terminal"}', 'migration-terminal', 'published');

DO $$
BEGIN
  IF (SELECT event_data FROM public.pending_lifecycle_actions WHERE idempotency_key = 'migration-terminal') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Terminal lifecycle payload was not scrubbed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.battle_hub_pending_lifecycle_actions
    WHERE shopify_order_id = 'migration-terminal'
  ) THEN
    RAISE EXCEPTION 'Battle Hub view exposes terminal lifecycle actions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.battle_hub_pending_lifecycle_actions
    WHERE shopify_order_id = 'migration-active'
  ) THEN
    RAISE EXCEPTION 'Battle Hub view does not expose active lifecycle actions';
  END IF;
END
$$;
