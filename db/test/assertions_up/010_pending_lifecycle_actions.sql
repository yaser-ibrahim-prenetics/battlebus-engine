BEGIN;

DO $$
BEGIN
  IF NOT has_table_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_actions',
    'SELECT,INSERT,UPDATE'
  ) OR has_table_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_actions',
    'DELETE'
  ) OR has_table_privilege(
    'authenticated',
    'public.pending_lifecycle_actions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Pending lifecycle action privilege contract failed';
  END IF;
END $$;

INSERT INTO public.pending_lifecycle_actions (
  order_id,
  action_type,
  source_event_id,
  event_name,
  event_data
) VALUES (
  '1001',
  'cancel',
  'shopify-order-cancelled-1001',
  'shopify/order.cancelled',
  '{"shopifyOrderId":"1001"}'::jsonb
);

DO $$
DECLARE
  stored_priority smallint;
BEGIN
  SELECT priority
  INTO stored_priority
  FROM public.pending_lifecycle_actions
  WHERE source_event_id = 'shopify-order-cancelled-1001';

  IF stored_priority <> 0 THEN
    RAISE EXCEPTION 'Cancellation priority should be 0, got %', stored_priority;
  END IF;

  BEGIN
    INSERT INTO public.pending_lifecycle_actions (
      order_id,
      action_type,
      source_event_id,
      event_name,
      event_data
    ) VALUES (
      '1001',
      'cancel',
      'shopify-order-cancelled-1001',
      'shopify/order.cancelled',
      '{"shopifyOrderId":"1001"}'::jsonb
    );
    RAISE EXCEPTION 'Duplicate source event unexpectedly inserted';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET status = 'publishing'
    WHERE source_event_id = 'shopify-order-cancelled-1001';
    RAISE EXCEPTION 'Publishing action unexpectedly accepted without a lease';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;
