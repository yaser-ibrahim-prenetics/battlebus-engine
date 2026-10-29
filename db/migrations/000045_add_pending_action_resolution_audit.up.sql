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

CREATE FUNCTION public.pending_lifecycle_action_rollback_status()
RETURNS TABLE (
  publishing_actions bigint,
  uncertain_queued_actions bigint,
  dead_letter_actions bigint,
  missing_queued_projections bigint,
  stale_terminal_projections bigint,
  safe_to_resume_legacy boolean
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH blocker_counts AS (
    SELECT
      count(*) FILTER (WHERE queue.status = 'publishing') AS publishing_actions,
      count(*) FILTER (
        WHERE queue.status = 'queued'
          AND (
            queue.attempts > 0
            OR EXISTS (
              SELECT 1
              FROM public.pending_lifecycle_action_resolutions AS resolution
              WHERE resolution.action_id = queue.action_id
            )
          )
      ) AS uncertain_queued_actions,
      count(*) FILTER (WHERE queue.status = 'dead_letter') AS dead_letter_actions
    FROM public.pending_lifecycle_actions AS queue
  ), projection_counts AS (
    SELECT count(*) AS missing_queued_projections
    FROM public.pending_lifecycle_actions AS queue
    WHERE queue.status = 'queued'
      AND NOT EXISTS (
        SELECT 1
        FROM public.orders AS orders
        CROSS JOIN LATERAL jsonb_array_elements(orders.pending_actions) AS item(action)
        WHERE (
            orders.shopify_order_id = queue.order_id
            OR orders.platform_order_id = queue.order_id
            OR orders.id::text = queue.order_id
          )
          AND item.action->>'action' = queue.action_type
          AND (
            item.action->>'sourceEventId' = queue.source_event_id
            OR (
              NULLIF(btrim(item.action->>'sourceEventId'), '') IS NULL
              AND 'legacy:' || md5(item.action::text) = queue.source_event_id
            )
          )
      )
  ), terminal_projection_counts AS (
    SELECT count(*) AS stale_terminal_projections
    FROM public.orders AS orders
    CROSS JOIN LATERAL jsonb_array_elements(orders.pending_actions) AS item(action)
    WHERE EXISTS (
      SELECT 1
      FROM public.pending_lifecycle_actions AS queue
      WHERE queue.status IN ('published', 'superseded')
        AND (
          orders.shopify_order_id = queue.order_id
          OR orders.platform_order_id = queue.order_id
          OR orders.id::text = queue.order_id
        )
        AND item.action->>'action' = queue.action_type
        AND (
          item.action->>'sourceEventId' = queue.source_event_id
          OR (
            NULLIF(btrim(item.action->>'sourceEventId'), '') IS NULL
            AND 'legacy:' || md5(item.action::text) = queue.source_event_id
          )
        )
    )
  )
  SELECT
    blocker_counts.publishing_actions,
    blocker_counts.uncertain_queued_actions,
    blocker_counts.dead_letter_actions,
    projection_counts.missing_queued_projections,
    terminal_projection_counts.stale_terminal_projections,
    blocker_counts.publishing_actions = 0
      AND blocker_counts.uncertain_queued_actions = 0
      AND blocker_counts.dead_letter_actions = 0
      AND projection_counts.missing_queued_projections = 0
      AND terminal_projection_counts.stale_terminal_projections = 0
  FROM blocker_counts
  CROSS JOIN projection_counts
  CROSS JOIN terminal_projection_counts
$$;

REVOKE ALL ON FUNCTION public.pending_lifecycle_action_rollback_status() FROM PUBLIC;

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
COMMENT ON FUNCTION public.pending_lifecycle_action_rollback_status() IS
  'Owner-only gate that blocks legacy drain rollback while normalized publication outcomes remain uncertain.';
COMMENT ON FUNCTION public.requeue_pending_lifecycle_action(uuid, text) IS
  'Owner-only reviewed replay that preserves action identity and records the database actor and reason.';
