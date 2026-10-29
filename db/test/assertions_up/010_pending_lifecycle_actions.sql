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
  ) OR NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_pending_lifecycle_actions',
    'SELECT'
  ) OR has_table_privilege(
    'battle_hub_runtime',
    'public.pending_lifecycle_actions',
    'SELECT'
  ) OR has_table_privilege(
    'authenticated',
    'public.battle_hub_pending_lifecycle_actions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Pending lifecycle action privilege contract failed';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.battle_hub_pending_lifecycle_actions') IS NULL THEN
    RAISE EXCEPTION 'Battle Hub pending-action view is missing';
  END IF;

  IF to_regclass('public.pending_lifecycle_action_resolutions') IS NULL
    OR to_regprocedure('public.requeue_pending_lifecycle_action(uuid,text)') IS NULL
  THEN
    RAISE EXCEPTION 'Pending-action replay audit objects are missing';
  END IF;

  IF has_function_privilege(
    'battle_bus_runtime',
    'public.requeue_pending_lifecycle_action(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'battle_hub_runtime',
    'public.requeue_pending_lifecycle_action(uuid,text)',
    'EXECUTE'
  ) OR has_table_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_action_resolutions',
    'SELECT'
  ) OR has_table_privilege(
    'battle_hub_runtime',
    'public.pending_lifecycle_action_resolutions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Runtime role can access owner-only replay audit objects';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'battle_hub_pending_lifecycle_actions'
      AND column_name = 'event_data'
  ) THEN
    RAISE EXCEPTION 'Battle Hub pending-action view exposes event payloads';
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

  UPDATE public.pending_lifecycle_actions
  SET status = 'published', published_at = now()
  WHERE source_event_id = 'shopify-order-cancelled-1001';

  IF EXISTS (
    SELECT 1
    FROM public.pending_lifecycle_actions
    WHERE source_event_id = 'shopify-order-cancelled-1001'
      AND event_data <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Published pending-action payload was not scrubbed';
  END IF;
END $$;

INSERT INTO public.pending_lifecycle_actions (
  order_id,
  action_type,
  source_event_id,
  event_name,
  event_data
) VALUES (
  '1002',
  'fulfill',
  'shopify-order-fulfilled-1002',
  'shopify/order.fulfilled',
  '{"shopifyOrderId":"1002","shopifyOrderName":"IM8-1002"}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.battle_hub_pending_lifecycle_actions
    WHERE shopify_order_id = '1002'
      AND shopify_order_name = 'IM8-1002'
      AND action = 'fulfill'
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Battle Hub active-action projection is incorrect';
  END IF;
END $$;

INSERT INTO public.pending_lifecycle_actions (
  order_id,
  action_type,
  source_event_id,
  event_name,
  event_data,
  status,
  attempts,
  last_error
) VALUES (
  '1003',
  'cancel',
  'shopify-order-cancelled-1003',
  'shopify/order.cancelled',
  '{"shopifyOrderId":"1003","secret":"not-visible"}'::jsonb,
  'dead_letter',
  10,
  'provider unavailable'
);

DO $$
DECLARE
  replay_action_id uuid;
BEGIN
  SELECT id
  INTO replay_action_id
  FROM public.battle_hub_pending_lifecycle_actions
  WHERE shopify_order_id = '1003'
    AND status = 'dead_letter'
    AND last_error = 'provider unavailable';

  IF replay_action_id IS NULL THEN
    RAISE EXCEPTION 'Battle Hub dead-letter projection is incorrect';
  END IF;

  PERFORM public.requeue_pending_lifecycle_action(
    replay_action_id,
    'INC-1003: provider outcome verified'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.pending_lifecycle_actions
    WHERE action_id = replay_action_id
      AND status = 'queued'
      AND attempts = 0
      AND last_error IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.pending_lifecycle_action_resolutions
    WHERE action_id = replay_action_id
      AND resolution = 'requeued'
      AND previous_status = 'dead_letter'
      AND previous_attempts = 10
      AND reason = 'INC-1003: provider outcome verified'
      AND performed_by = current_user
  ) THEN
    RAISE EXCEPTION 'Audited pending-action replay contract failed';
  END IF;
END $$;

ROLLBACK;
