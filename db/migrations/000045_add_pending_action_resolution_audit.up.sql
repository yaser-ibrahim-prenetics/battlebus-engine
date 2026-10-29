CREATE TABLE public.pending_lifecycle_action_resolutions (
  resolution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL REFERENCES public.pending_lifecycle_actions(action_id) ON DELETE RESTRICT,
  resolution text NOT NULL CHECK (resolution IN ('requeued')),
  previous_status text NOT NULL CHECK (previous_status IN ('dead_letter')),
  previous_attempts integer NOT NULL CHECK (previous_attempts >= 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  performed_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pending_lifecycle_action_resolutions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pending_lifecycle_action_resolutions
  FROM PUBLIC, anon, authenticated, battle_bus_runtime, battle_hub_runtime;

CREATE FUNCTION public.requeue_pending_lifecycle_action(
  requested_action_id uuid,
  resolution_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  action_status text;
  action_attempts integer;
BEGIN
  IF resolution_reason IS NULL
    OR char_length(btrim(resolution_reason)) NOT BETWEEN 10 AND 1000
  THEN
    RAISE EXCEPTION 'A replay reason between 10 and 1000 characters is required';
  END IF;

  SELECT status, attempts
  INTO action_status, action_attempts
  FROM public.pending_lifecycle_actions
  WHERE action_id = requested_action_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending lifecycle action % does not exist', requested_action_id;
  END IF;

  IF action_status <> 'dead_letter' THEN
    RAISE EXCEPTION 'Pending lifecycle action % is %, not dead_letter',
      requested_action_id,
      action_status;
  END IF;

  UPDATE public.pending_lifecycle_actions
  SET status = 'queued',
      attempts = 0,
      available_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      published_at = NULL,
      superseded_at = NULL,
      updated_at = now()
  WHERE action_id = requested_action_id;

  INSERT INTO public.pending_lifecycle_action_resolutions (
    action_id,
    resolution,
    previous_status,
    previous_attempts,
    reason
  ) VALUES (
    requested_action_id,
    'requeued',
    action_status,
    action_attempts,
    btrim(resolution_reason)
  );

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.requeue_pending_lifecycle_action(uuid, text) FROM PUBLIC;

COMMENT ON TABLE public.pending_lifecycle_action_resolutions IS
  'Append-only owner audit of reviewed dead-letter lifecycle action replays.';
COMMENT ON FUNCTION public.requeue_pending_lifecycle_action(uuid, text) IS
  'Owner-only reviewed replay that preserves action identity and records the database actor and reason.';
