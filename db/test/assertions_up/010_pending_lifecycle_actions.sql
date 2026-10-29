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
    OR to_regclass('public.pending_lifecycle_action_discards') IS NULL
    OR to_regprocedure('public.requeue_pending_lifecycle_action(uuid,text)') IS NULL
    OR to_regprocedure('public.pending_lifecycle_action_rollback_status()') IS NULL
    OR to_regprocedure('public.discard_dead_letter_pending_lifecycle_action(uuid,text)') IS NULL
    OR to_regprocedure('public.battle_platform_enforce_pending_action_transition()') IS NULL
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
  ) OR has_function_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_action_rollback_status()',
    'EXECUTE'
  ) OR has_function_privilege(
    'battle_hub_runtime',
    'public.pending_lifecycle_action_rollback_status()',
    'EXECUTE'
  ) OR has_function_privilege(
    'battle_bus_runtime',
    'public.discard_dead_letter_pending_lifecycle_action(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'battle_hub_runtime',
    'public.discard_dead_letter_pending_lifecycle_action(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'battle_bus_runtime',
    'public.battle_platform_enforce_pending_action_transition()',
    'EXECUTE'
  ) OR has_table_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_action_resolutions',
    'SELECT'
  ) OR has_table_privilege(
    'battle_hub_runtime',
    'public.pending_lifecycle_action_resolutions',
    'SELECT'
  ) OR has_table_privilege(
    'battle_bus_runtime',
    'public.pending_lifecycle_action_discards',
    'SELECT'
  ) OR has_table_privilege(
    'battle_hub_runtime',
    'public.pending_lifecycle_action_discards',
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
  SET status = 'publishing',
      attempts = attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  WHERE source_event_id = 'shopify-order-cancelled-1001';

  UPDATE public.pending_lifecycle_actions
  SET status = 'published',
      published_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL
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

INSERT INTO public.orders (
  id,
  order_number,
  title,
  shopify_order_id,
  pending_actions
) VALUES (
  'pending-action-1002',
  '1002',
  'IM8-1002',
  '1002',
  '[{
    "action":"fulfill",
    "eventName":"shopify/order.fulfilled",
    "eventData":{"shopifyOrderId":"1002","shopifyOrderName":"IM8-1002"},
    "sourceEventId":"shopify-order-fulfilled-1002"
  }]'::jsonb
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
  rollback_safe boolean;
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

  SELECT safe_to_resume_legacy
  INTO rollback_safe
  FROM public.pending_lifecycle_action_rollback_status();

  IF rollback_safe THEN
    RAISE EXCEPTION 'Dead-letter action did not block legacy rollback';
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

  SELECT safe_to_resume_legacy
  INTO rollback_safe
  FROM public.pending_lifecycle_action_rollback_status();

  IF rollback_safe THEN
    RAISE EXCEPTION 'Unsettled audited replay did not block legacy rollback';
  END IF;

  UPDATE public.pending_lifecycle_actions
  SET status = 'publishing',
      attempts = attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  WHERE action_id = replay_action_id;

  UPDATE public.pending_lifecycle_actions
  SET status = 'published',
      published_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE action_id = replay_action_id;

  SELECT safe_to_resume_legacy
  INTO rollback_safe
  FROM public.pending_lifecycle_action_rollback_status();

  IF NOT rollback_safe THEN
    RAISE EXCEPTION 'Settled replay still blocks legacy rollback';
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
  '1004',
  'refund',
  'shopify-order-refunded-1004',
  'shopify/order.refunded',
  '{"shopifyOrderId":"1004","sensitive":"discard-me"}'::jsonb,
  'dead_letter',
  10,
  'review required'
);

INSERT INTO public.orders (
  id,
  order_number,
  title,
  shopify_order_id,
  pending_actions
) VALUES (
  'pending-action-1004',
  '1004',
  'IM8-1004',
  '1004',
  '[{
    "action":"refund",
    "eventName":"shopify/order.refunded",
    "eventData":{"shopifyOrderId":"1004","sensitive":"discard-me"},
    "sourceEventId":"shopify-order-refunded-1004"
  }]'::jsonb
);

INSERT INTO public.pending_lifecycle_actions (
  order_id,
  action_type,
  source_event_id,
  event_name,
  event_data
) VALUES
  (
    '1005',
    'cancel',
    'shopify-order-cancelled-1005',
    'shopify/order.cancelled',
    '{"shopifyOrderId":"1005"}'::jsonb
  ),
  (
    '1005',
    'refund',
    'shopify-order-refunded-1005',
    'shopify/order.refunded',
    '{"shopifyOrderId":"1005"}'::jsonb
  );

INSERT INTO public.orders (
  id,
  order_number,
  title,
  shopify_order_id,
  pending_actions
) VALUES (
  'pending-action-1005',
  '1005',
  'IM8-1005',
  '1005',
  '[{
    "action":"cancel",
    "eventName":"shopify/order.cancelled",
    "eventData":{"shopifyOrderId":"1005"},
    "sourceEventId":"shopify-order-cancelled-1005"
  },{
    "action":"refund",
    "eventName":"shopify/order.refunded",
    "eventData":{"shopifyOrderId":"1005"},
    "sourceEventId":"shopify-order-refunded-1005"
  }]'::jsonb
);

SET LOCAL ROLE battle_bus_runtime;

DO $$
BEGIN
  BEGIN
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
      'runtime-forged',
      'refund',
      'runtime-forged-dead-letter',
      'shopify/order.refunded',
      '{}'::jsonb,
      'dead_letter',
      10,
      'forged terminal row'
    );
    RAISE check_violation USING MESSAGE = 'Runtime role inserted forged terminal evidence';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET status = 'queued', attempts = 0, last_error = NULL
    WHERE source_event_id = 'shopify-order-refunded-1004';
    RAISE check_violation USING
      MESSAGE = 'Runtime role bypassed audited dead-letter resolution';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET last_error = 'forged terminal mutation'
    WHERE source_event_id = 'shopify-order-cancelled-1001';
    RAISE check_violation USING MESSAGE = 'Runtime role mutated terminal evidence';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET event_data = '{"forged":true}'::jsonb
    WHERE source_event_id = 'shopify-order-fulfilled-1002';
    RAISE check_violation USING MESSAGE = 'Runtime role mutated replay payload';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET status = 'superseded',
        superseded_at = now(),
        last_error = 'forged cancellation supersession'
    WHERE source_event_id = 'shopify-order-cancelled-1005';
    RAISE check_violation USING MESSAGE = 'Runtime role superseded a cancellation';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    UPDATE public.pending_lifecycle_actions
    SET status = 'superseded',
        superseded_at = now(),
        last_error = 'forged refund supersession'
    WHERE source_event_id = 'shopify-order-refunded-1005';
    RAISE check_violation USING MESSAGE = 'Runtime role superseded a refund';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.pending_lifecycle_actions (
      order_id,
      action_type,
      source_event_id,
      event_name,
      event_data
    ) VALUES
      (
        '1006',
        'cancel',
        'shopify-order-cancelled-1006',
        'shopify/order.cancelled',
        '{"shopifyOrderId":"1006"}'::jsonb
      ),
      (
        '1006',
        'fulfill',
        'shopify-order-fulfilled-1006',
        'shopify/order.fulfilled',
        '{"shopifyOrderId":"1006"}'::jsonb
      );

    UPDATE public.pending_lifecycle_actions
    SET status = 'publishing',
        attempts = attempts + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '2 minutes'
    WHERE source_event_id = 'shopify-order-fulfilled-1006';

    UPDATE public.pending_lifecycle_actions
    SET status = 'superseded',
        superseded_at = now(),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = 'forged active-lease supersession'
    WHERE source_event_id = 'shopify-order-fulfilled-1006';
    RAISE check_violation USING MESSAGE = 'Runtime role superseded an active fulfillment lease';
  EXCEPTION
    WHEN raise_exception THEN
      NULL;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  discarded_action_id uuid;
  rollback_safe boolean;
BEGIN
  SELECT action_id
  INTO discarded_action_id
  FROM public.pending_lifecycle_actions
  WHERE source_event_id = 'shopify-order-refunded-1004';

  PERFORM public.discard_dead_letter_pending_lifecycle_action(
    discarded_action_id,
    'INC-1004: invalid source event approved for discard'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.pending_lifecycle_actions
    WHERE action_id = discarded_action_id
      AND status = 'superseded'
      AND event_data = '{}'::jsonb
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.pending_lifecycle_action_discards
    WHERE action_id = discarded_action_id
      AND reason = 'INC-1004: invalid source event approved for discard'
  ) OR EXISTS (
    SELECT 1
    FROM public.orders
    WHERE shopify_order_id = '1004'
      AND jsonb_array_length(pending_actions) <> 0
  ) THEN
    RAISE EXCEPTION 'Audited pending-action discard contract failed';
  END IF;

  BEGIN
    INSERT INTO public.pending_lifecycle_actions (
      order_id,
      action_type,
      source_event_id,
      event_name,
      event_data
    ) VALUES (
      'oversized',
      'refund',
      'oversized-payload',
      'shopify/order.refunded',
      jsonb_build_object('payload', repeat('x', 524289))
    );
    RAISE EXCEPTION 'Oversized replay payload unexpectedly inserted';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  SELECT safe_to_resume_legacy
  INTO rollback_safe
  FROM public.pending_lifecycle_action_rollback_status();

  IF NOT rollback_safe THEN
    RAISE EXCEPTION 'Resolved and projection-consistent queue blocks rollback';
  END IF;
END $$;

ROLLBACK;
