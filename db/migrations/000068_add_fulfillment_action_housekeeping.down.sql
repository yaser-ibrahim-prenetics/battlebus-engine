INSERT INTO public.fulfillment_actions (
  action_key,
  provider,
  scope,
  source_order_id,
  source_line_id,
  action_name,
  request_hash,
  attempt_id,
  status,
  result,
  created_at,
  updated_at
)
SELECT
  action_key,
  provider,
  scope,
  source_order_id,
  source_line_id,
  action_name,
  request_hash,
  attempt_id,
  status,
  result,
  created_at,
  completed_at
FROM public.fulfillment_action_tombstones
ON CONFLICT (action_key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.fulfillment_action_tombstones AS tombstone
    LEFT JOIN public.fulfillment_actions AS action USING (action_key)
    WHERE action.action_key IS NULL
      OR action.provider <> tombstone.provider
      OR action.scope <> tombstone.scope
      OR action.source_order_id <> tombstone.source_order_id
      OR action.source_line_id <> tombstone.source_line_id
      OR action.action_name <> tombstone.action_name
      OR action.request_hash <> tombstone.request_hash
      OR action.attempt_id <> tombstone.attempt_id
      OR action.status <> 'succeeded'
      OR action.result <> tombstone.result
  ) THEN
    RAISE EXCEPTION
      'Cannot roll back fulfillment housekeeping because a replay tombstone could not be rehydrated exactly';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.fulfillment_actions_terminal_retention;
DROP INDEX IF EXISTS public.fulfillment_actions_unresolved_age;

DROP FUNCTION IF EXISTS public.delete_retained_fulfillment_actions(integer, integer);

DROP FUNCTION IF EXISTS public.consume_fulfillment_housekeeping_successor(uuid);
DROP FUNCTION IF EXISTS public.authorize_fulfillment_housekeeping_successor(uuid);
DROP FUNCTION IF EXISTS public.claim_fulfillment_housekeeping_successor(
  text, integer, integer, integer
);
DROP FUNCTION IF EXISTS public.record_fulfillment_housekeeping_run_receipt(
  text, integer, integer, integer, integer, integer, integer, boolean, uuid, text, integer
);
DROP TABLE IF EXISTS public.fulfillment_housekeeping_successor;
DROP TABLE IF EXISTS public.fulfillment_housekeeping_run_receipts;
DROP TABLE IF EXISTS public.fulfillment_action_housekeeping_quarantine;

DROP TABLE IF EXISTS public.fulfillment_action_tombstones;
DROP FUNCTION IF EXISTS public.minimize_fulfillment_action_replay_result(text, text, jsonb);

ALTER TABLE public.fulfillment_actions
  DROP CONSTRAINT IF EXISTS fulfillment_actions_unresolved_age;

DROP TRIGGER IF EXISTS fulfillment_actions_track_unresolved_age
  ON public.fulfillment_actions;
DROP FUNCTION IF EXISTS public.battle_platform_track_fulfillment_unresolved_age();

ALTER TABLE public.fulfillment_actions
  DROP COLUMN IF EXISTS last_unresolved_alert_at,
  DROP COLUMN IF EXISTS unresolved_since;
