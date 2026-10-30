DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fulfillment_actions'
      AND column_name = 'unresolved_since' AND data_type = 'timestamp with time zone'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fulfillment_actions'
      AND column_name = 'last_unresolved_alert_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'Fulfillment unresolved-age columns are missing';
  END IF;

  IF to_regclass('public.fulfillment_actions_terminal_retention') IS NULL
    OR to_regclass('public.fulfillment_actions_unresolved_age') IS NULL
    OR to_regprocedure('public.battle_platform_track_fulfillment_unresolved_age()') IS NULL
    OR to_regprocedure('public.delete_retained_fulfillment_actions(integer,integer)') IS NULL
  THEN
    RAISE EXCEPTION 'Fulfillment housekeeping indexes or trigger function are missing';
  END IF;

  IF NOT has_function_privilege(
      'battle_bus_runtime',
      'public.delete_retained_fulfillment_actions(integer,integer)',
      'EXECUTE'
    )
    OR has_table_privilege('battle_bus_runtime', 'public.fulfillment_actions', 'DELETE')
    OR has_table_privilege('battle_bus_runtime', 'public.fulfillment_action_aliases', 'DELETE')
    OR has_table_privilege('battle_bus_runtime', 'public.fulfillment_evidence_claims', 'DELETE')
  THEN
    RAISE EXCEPTION 'Fulfillment housekeeping least-privilege contract failed';
  END IF;
END
$$;

BEGIN;
SET LOCAL ROLE battle_bus_runtime;

INSERT INTO public.fulfillment_actions (
  action_key, provider, scope, source_order_id, source_line_id,
  action_name, request_hash, attempt_id, status
) VALUES (
  'housekeeping-fixture', 'gps', 'fixture', 'ORDER-1', 'LINE-1',
  'shipment:fixture', repeat('a', 64), gen_random_uuid(), 'pending'
);

INSERT INTO public.fulfillment_actions (
  action_key, provider, scope, source_order_id, source_line_id,
  action_name, request_hash, attempt_id, status, created_at, updated_at
) VALUES (
  'housekeeping-expired-fixture', 'gps', 'fixture', 'ORDER-2', 'LINE-2',
  'shipment:expired-fixture', repeat('b', 64), gen_random_uuid(), 'failed',
  now() - interval '91 days', now() - interval '91 days'
);

DO $$
DECLARE
  cleanup record;
BEGIN
  SELECT * INTO cleanup FROM public.delete_retained_fulfillment_actions(90, 1);
  IF cleanup.deleted <> 1 OR EXISTS (
    SELECT 1 FROM public.fulfillment_actions WHERE action_key = 'housekeeping-expired-fixture'
  ) THEN
    RAISE EXCEPTION 'Bounded fulfillment cleanup did not delete the expired terminal action';
  END IF;
END
$$;

DO $$
DECLARE
  original_unresolved_since timestamptz;
  retried_unresolved_since timestamptz;
BEGIN
  SELECT unresolved_since INTO original_unresolved_since
  FROM public.fulfillment_actions WHERE action_key = 'housekeeping-fixture';

  UPDATE public.fulfillment_actions
  SET status = 'uncertain', updated_at = now() + interval '1 minute'
  WHERE action_key = 'housekeeping-fixture';

  SELECT unresolved_since INTO retried_unresolved_since
  FROM public.fulfillment_actions WHERE action_key = 'housekeeping-fixture';

  IF original_unresolved_since IS NULL OR retried_unresolved_since <> original_unresolved_since THEN
    RAISE EXCEPTION 'Unresolved age changed during an unresolved retry';
  END IF;

  UPDATE public.fulfillment_actions
  SET status = 'failed', updated_at = now()
  WHERE action_key = 'housekeeping-fixture';

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_actions
    WHERE action_key = 'housekeeping-fixture' AND unresolved_since IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Resolved fulfillment action retained unresolved age';
  END IF;

  UPDATE public.fulfillment_actions
  SET status = 'pending', updated_at = now()
  WHERE action_key = 'housekeeping-fixture';

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_actions
    WHERE action_key = 'housekeeping-fixture'
      AND (unresolved_since IS NULL OR unresolved_since = original_unresolved_since)
  ) THEN
    RAISE EXCEPTION 'A new unresolved period did not receive a new stable age';
  END IF;
END
$$;

ROLLBACK;
