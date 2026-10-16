BEGIN;

CREATE TABLE public.workflow_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  shopify_order_id text,
  shopify_order_name text,
  source text NOT NULL,
  event_type text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  message text,
  run_id text,
  error_class text,
  recovery_action text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_timeline_order_present CHECK (
    shopify_order_id IS NOT NULL OR shopify_order_name IS NOT NULL
  ),
  CONSTRAINT workflow_timeline_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_workflow_timeline_order_id
  ON public.workflow_timeline_events (shopify_order_id, occurred_at, id);
CREATE INDEX idx_workflow_timeline_order_name
  ON public.workflow_timeline_events (shopify_order_name, occurred_at, id);
CREATE INDEX idx_workflow_timeline_status
  ON public.workflow_timeline_events (status, occurred_at DESC);

ALTER TABLE public.workflow_timeline_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_timeline_events FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.workflow_timeline_events TO service_role;

CREATE POLICY workflow_timeline_events_service_role_all
  ON public.workflow_timeline_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.battle_platform_capture_outbox_timeline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shopify_order_id IS NULL AND NEW.shopify_order_name IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.workflow_timeline_events (
    idempotency_key,
    shopify_order_id,
    shopify_order_name,
    source,
    event_type,
    stage,
    status,
    message,
    error_class,
    recovery_action,
    metadata,
    occurred_at
  )
  VALUES (
    concat('outbox:', NEW.id::text, ':', NEW.state, ':', NEW.attempts::text),
    NEW.shopify_order_id,
    NEW.shopify_order_name,
    NEW.source,
    'outbox',
    NEW.event_name,
    NEW.state,
    NEW.last_error,
    NEW.error_class,
    NEW.recovery_action,
    jsonb_build_object(
      'outboxId', NEW.id,
      'eventId', NEW.event_id,
      'attempts', NEW.attempts,
      'schemaVersion', NEW.schema_version
    ),
    now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_event_outbox_timeline
  AFTER INSERT OR UPDATE OF state, attempts, last_error ON public.event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_capture_outbox_timeline();

CREATE OR REPLACE FUNCTION public.battle_platform_capture_flow_log_timeline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shopify_order_id IS NULL AND NEW.shopify_order_name IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.workflow_timeline_events (
    idempotency_key,
    shopify_order_id,
    shopify_order_name,
    source,
    event_type,
    stage,
    status,
    message,
    run_id,
    error_class,
    metadata,
    occurred_at
  )
  VALUES (
    concat('flow-log:', NEW.id::text),
    NEW.shopify_order_id,
    NEW.shopify_order_name,
    COALESCE(NEW.client, NEW.flow),
    'workflow',
    COALESCE(NEW.step, NEW.flow),
    COALESCE(NEW.status, NEW.level),
    NEW.error_message,
    NEW.run_id,
    NEW.error_type,
    jsonb_strip_nulls(jsonb_build_object(
      'flow', NEW.flow,
      'durationMs', NEW.duration_ms,
      'requestId', NEW.request_id,
      'd365OrderNumber', NEW.d365_order_number
    )),
    NEW.ts
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_flow_log_timeline
  AFTER INSERT ON public.flow_logs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_capture_flow_log_timeline();

COMMENT ON TABLE public.workflow_timeline_events IS
  'Append-only, idempotent per-order workflow history derived from durable delivery and execution state.';

COMMIT;
