CREATE TABLE public.pending_lifecycle_actions (
  action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL CHECK (length(btrim(order_id)) BETWEEN 1 AND 255),
  action_type text NOT NULL CHECK (action_type IN ('cancel', 'refund', 'fulfill')),
  source_event_id text NOT NULL
    CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 1024),
  event_name text NOT NULL CHECK (length(btrim(event_name)) BETWEEN 1 AND 255),
  event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
  priority smallint GENERATED ALWAYS AS (
    CASE action_type
      WHEN 'cancel' THEN 0
      WHEN 'refund' THEN 1
      WHEN 'fulfill' THEN 2
    END
  ) STORED,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'publishing', 'published', 'dead_letter', 'superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT pending_lifecycle_actions_source_unique
    UNIQUE (order_id, action_type, source_event_id),
  CONSTRAINT pending_lifecycle_actions_lease_state
    CHECK (
      (status = 'publishing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'publishing' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
  CONSTRAINT pending_lifecycle_actions_published_state
    CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT pending_lifecycle_actions_superseded_state
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

COMMENT ON TABLE public.pending_lifecycle_actions IS
  'Durable lifecycle-action queue. Stable action IDs provide downstream event idempotency; leases permit concurrent workers without duplicate claims.';
COMMENT ON COLUMN public.pending_lifecycle_actions.source_event_id IS
  'Stable producer event ID used with order_id and action_type to deduplicate enqueue attempts.';
COMMENT ON COLUMN public.pending_lifecycle_actions.action_id IS
  'Stable queue identity reused as the emitted Inngest event ID across retries.';

CREATE OR REPLACE FUNCTION public.battle_platform_scrub_pending_action_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('published', 'superseded') THEN
    NEW.event_data := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER battle_platform_scrub_pending_action_payload
  BEFORE INSERT OR UPDATE ON public.pending_lifecycle_actions
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_scrub_pending_action_payload();

COMMENT ON FUNCTION public.battle_platform_scrub_pending_action_payload() IS
  'Removes lifecycle event payloads when queue rows reach a non-replayable terminal state.';
