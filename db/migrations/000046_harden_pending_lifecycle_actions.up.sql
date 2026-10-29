ALTER TABLE public.pending_lifecycle_actions
  ADD CONSTRAINT pending_lifecycle_actions_event_data_size
  CHECK (octet_length(event_data::text) <= 524288) NOT VALID;

CREATE TABLE public.pending_lifecycle_action_discards (
  discard_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL UNIQUE
    REFERENCES public.pending_lifecycle_actions(action_id) ON DELETE RESTRICT,
  previous_status text NOT NULL CHECK (previous_status = 'dead_letter'),
  previous_attempts integer NOT NULL CHECK (previous_attempts >= 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  performed_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pending_lifecycle_action_discards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pending_lifecycle_action_discards
  FROM PUBLIC, anon, authenticated, battle_bus_runtime, battle_hub_runtime;

CREATE FUNCTION public.battle_platform_enforce_pending_action_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime_actor boolean := NOT COALESCE(
      (SELECT roles.rolsuper FROM pg_roles AS roles WHERE roles.rolname = current_user),
      false
    )
    AND (
      current_user = 'battle_bus_runtime'
      OR pg_has_role(current_user, 'battle_bus_runtime', 'member')
    );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF runtime_actor AND (
      NEW.status <> 'queued'
      OR NEW.attempts <> 0
      OR NEW.lease_token IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.last_error IS NOT NULL
      OR NEW.published_at IS NOT NULL
      OR NEW.superseded_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Runtime role can insert only fresh queued lifecycle actions';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.action_type IS DISTINCT FROM OLD.action_type
    OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
    OR NEW.event_name IS DISTINCT FROM OLD.event_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Pending lifecycle action identity is immutable';
  END IF;

  IF NEW.event_data IS DISTINCT FROM OLD.event_data THEN
    RAISE EXCEPTION 'Pending lifecycle action payload is immutable outside terminal scrubbing';
  END IF;

  IF OLD.status IN ('published', 'superseded') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal pending lifecycle actions are immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF runtime_actor AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Pending lifecycle action state cannot be mutated in place';
    END IF;
    RETURN NEW;
  END IF;

  IF runtime_actor AND OLD.status = 'dead_letter' THEN
    RAISE EXCEPTION 'Runtime role cannot resolve dead-letter pending lifecycle actions';
  END IF;

  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('publishing', 'superseded'))
    OR (
      OLD.status = 'publishing'
      AND NEW.status IN ('queued', 'published', 'dead_letter', 'superseded')
    )
    OR (
      NOT runtime_actor
      AND OLD.status = 'dead_letter'
      AND NEW.status IN ('queued', 'superseded')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid pending lifecycle action transition: % -> %', OLD.status, NEW.status;
  END IF;

  IF runtime_actor THEN
    IF OLD.status = 'queued' AND NEW.status = 'publishing' THEN
      IF NEW.attempts <> OLD.attempts + 1
        OR NEW.lease_token IS NULL
        OR NEW.lease_expires_at IS NULL
        OR NEW.lease_expires_at <= now()
      THEN
        RAISE EXCEPTION 'Invalid pending lifecycle action claim';
      END IF;
    ELSIF NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'Runtime role cannot rewrite pending lifecycle action attempts';
    END IF;

    IF NEW.status = 'superseded' AND NOT EXISTS (
      SELECT 1
      FROM public.pending_lifecycle_actions AS cancellation
      WHERE cancellation.order_id = OLD.order_id
        AND cancellation.action_type = 'cancel'
        AND cancellation.status IN ('queued', 'publishing', 'published', 'dead_letter')
    ) THEN
      RAISE EXCEPTION 'Runtime role cannot supersede an action without a cancellation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_enforce_pending_action_transition
  BEFORE INSERT OR UPDATE ON public.pending_lifecycle_actions
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_enforce_pending_action_transition();

REVOKE ALL ON FUNCTION public.battle_platform_enforce_pending_action_transition() FROM PUBLIC;

CREATE FUNCTION public.discard_dead_letter_pending_lifecycle_action(
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
  action_order_id text;
  resolved_action_type text;
  action_source_event_id text;
BEGIN
  IF resolution_reason IS NULL
    OR char_length(btrim(resolution_reason)) NOT BETWEEN 10 AND 1000
  THEN
    RAISE EXCEPTION 'A discard reason between 10 and 1000 characters is required';
  END IF;

  SELECT status, attempts, order_id, pending.action_type, source_event_id
  INTO action_status, action_attempts, action_order_id, resolved_action_type, action_source_event_id
  FROM public.pending_lifecycle_actions AS pending
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

  INSERT INTO public.pending_lifecycle_action_discards (
    action_id,
    previous_status,
    previous_attempts,
    reason
  ) VALUES (
    requested_action_id,
    action_status,
    action_attempts,
    btrim(resolution_reason)
  );

  UPDATE public.pending_lifecycle_actions
  SET status = 'superseded',
      superseded_at = now(),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = 'Discarded after reviewed dead-letter resolution',
      published_at = NULL,
      updated_at = now()
  WHERE action_id = requested_action_id;

  UPDATE public.orders AS orders
  SET pending_actions = (
        SELECT COALESCE(
          jsonb_agg(item.action ORDER BY item.ordinality),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(orders.pending_actions)
          WITH ORDINALITY AS item(action, ordinality)
        WHERE (
          item.action->>'action' = resolved_action_type
          AND (
            item.action->>'sourceEventId' = action_source_event_id
            OR (
              NULLIF(btrim(item.action->>'sourceEventId'), '') IS NULL
              AND 'legacy:' || md5(item.action::text) = action_source_event_id
            )
          )
        ) IS NOT TRUE
      ),
      updated_at = now()
  WHERE orders.shopify_order_id = action_order_id
     OR orders.platform_order_id = action_order_id
     OR orders.id::text = action_order_id;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.discard_dead_letter_pending_lifecycle_action(uuid, text)
  FROM PUBLIC;

COMMENT ON CONSTRAINT pending_lifecycle_actions_event_data_size
  ON public.pending_lifecycle_actions IS
  'Bounds sensitive replay payloads to 512 KiB before storage.';
COMMENT ON TABLE public.pending_lifecycle_action_discards IS
  'Append-only owner audit of reviewed dead-letter lifecycle actions discarded without replay.';
COMMENT ON FUNCTION public.battle_platform_enforce_pending_action_transition() IS
  'Prevents runtime roles from mutating queue identity, payloads, terminal evidence, attempts, or dead-letter state outside valid transitions.';
COMMENT ON FUNCTION public.discard_dead_letter_pending_lifecycle_action(uuid, text) IS
  'Owner-only audited discard that scrubs a reviewed dead-letter payload and removes its exact rollback projection.';
